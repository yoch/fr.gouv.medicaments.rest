import config from './config.mts';
import { getRuntimeConfig } from './runtimeConfig.mts';
import {
  listCorpusPage,
  search,
  searchPage,
  getMetadata,
  isHasAvisLoaded,
  isMitmLoaded
} from './services/dataLoader.mts';
import {
  listVetCorpusPage,
  searchVet,
  searchVetPage,
  getVetMetadata
} from './services/vetDataLoader.mts';
import { createListExecutor } from './utils/routeHelpers.mts';
import { validateSearchQueryParams } from './utils/validateSearchQuery.mts';
import {
  resolvePublicIndexHtmlPath,
  buildHealthPayload,
  executeMedicamentSearchRoute,
  getSpecialiteDetailResult,
  getVeterinaireDetailResult,
  getDisponibiliteAlertsResult,
  getDisponibiliteAlertDetailResult,
  getDisponibiliteListResult,
  type JsonRouteResult
} from './handlers/apiHandlers.mts';
import {
  createServerLifecycle,
  shouldRestartOnDataChange,
  reloadBdpmAfterChange,
  reloadVetAfterChange,
  type ManagedServerInstance
} from './services/serverLifecycle.mts';
import { singleFlight } from './utils/singleFlight.mts';
import swaggerSpecs from './swagger.js';

export interface BunServeOptions {
  port?: number;
  hostname?: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-XSS-Protection': '0'
};

const PREFLIGHT_HEADERS: Record<string, string> = {
  ...SECURITY_HEADERS,
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const JSON_SECURITY_HEADERS: Record<string, string> = {
  ...SECURITY_HEADERS
};

const MARKDOWN_HEADERS: Record<string, string> = {
  ...SECURITY_HEADERS,
  'Content-Type': 'text/markdown; charset=utf-8'
};

const PRETTY_JSON_HEADERS: Record<string, string> = {
  ...SECURITY_HEADERS,
  'Content-Type': 'application/json; charset=utf-8'
};

const bdpmList = createListExecutor({ getMetadata, search, searchPage, listCorpusPage });
const vetList = createListExecutor({
  getMetadata: getVetMetadata,
  search: searchVet,
  searchPage: searchVetPage,
  listCorpusPage: listVetCorpusPage
});

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

interface BunRateLimiter {
  check: (ip: string) => { allowed: boolean; remaining: number; resetSeconds: number };
  dispose: () => void;
}

function createMemoryRateLimiter(windowMs: number, max: number): BunRateLimiter {
  const buckets = new Map<string, RateLimitBucket>();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, windowMs);
  if (typeof cleanup.unref === 'function') cleanup.unref();

  return {
    check(ip: string) {
      const now = Date.now();
      let bucket = buckets.get(ip);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(ip, bucket);
      }
      bucket.count++;
      const remaining = Math.max(0, max - bucket.count);
      const resetSeconds = Math.ceil((bucket.resetAt - now) / 1000);
      return {
        allowed: bucket.count <= max,
        remaining,
        resetSeconds
      };
    },
    dispose() {
      clearInterval(cleanup);
      buckets.clear();
    }
  };
}

function validateBunSearchQuery(params: URLSearchParams): string | null {
  return validateSearchQueryParams((name) => {
    const all = params.getAll(name);
    if (all.length > 1) return { value: all, isMultiple: true };
    return { value: all.length === 1 ? all[0] : undefined, isMultiple: false };
  });
}

function jsonResultResponse(result: JsonRouteResult): Response {
  return Response.json(result.json, { status: result.status, headers: JSON_SECURITY_HEADERS });
}

function paramsToDisponibiliteQuery(params: URLSearchParams): Record<string, unknown> {
  return {
    q: params.get('q') ?? undefined,
    page: params.get('page') ?? undefined,
    limit: params.get('limit') ?? undefined,
    cis: params.get('cis') ?? undefined,
    cip13: params.get('cip13') ?? undefined,
    code_statut: params.get('code_statut') ?? undefined,
    date_mise_a_jour_min: params.get('date_mise_a_jour_min') ?? undefined,
    lien_ansm: params.get('lien_ansm') ?? undefined
  };
}

function handleGuardedBdpmList(
  isLoaded: () => boolean,
  unavailableError: string,
  dataType: string,
  params: URLSearchParams
): Response {
  if (!isLoaded()) {
    return Response.json({ error: unavailableError }, { status: 410, headers: JSON_SECURITY_HEADERS });
  }
  return Response.json(
    bdpmList(dataType, params.get('q') ?? undefined, params.get('page') ?? undefined, params.get('limit') ?? undefined),
    { status: 200, headers: JSON_SECURITY_HEADERS }
  );
}

function startBunHttpServer(options: BunServeOptions = {}) {
  const port = options.port ?? config.port;
  const hostname = options.hostname;
  const indexPath = resolvePublicIndexHtmlPath();
  const rateLimiter = config.enableRateLimit
    ? createMemoryRateLimiter(config.rateLimitWindowMs, config.rateLimitMax)
    : null;

  let activeServer: ReturnType<typeof Bun.serve> | null = null;

  function applyRateLimit(req: Request): Response | null {
    if (!rateLimiter || !activeServer) return null;
    const ip = activeServer.requestIP(req)?.address ?? 'unknown';
    const decision = rateLimiter.check(ip);
    if (decision.allowed) return null;
    return Response.json(
      {
        status: 429,
        error: 'Too Many Requests',
        message: 'Vous avez dépassé la limite de requêtes autorisée. Veuillez réessayer plus tard.'
      },
      {
        status: 429,
        headers: {
          ...JSON_SECURITY_HEADERS,
          'RateLimit-Limit': String(config.rateLimitMax),
          'RateLimit-Remaining': String(decision.remaining),
          'RateLimit-Reset': String(decision.resetSeconds)
        }
      }
    );
  }

  function handleWithValidation(
    req: Request,
    handler: (params: URLSearchParams) => Response
  ): Response {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
    }
    const limited = applyRateLimit(req);
    if (limited) return limited;

    const params = new URL(req.url).searchParams;
    const validationError = validateBunSearchQuery(params);
    if (validationError) {
      return Response.json({ error: validationError }, { status: 400, headers: JSON_SECURITY_HEADERS });
    }
    return handler(params);
  }

  function handleSimple(req: Request, handler: () => Response): Response {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
    }
    const limited = applyRateLimit(req);
    if (limited) return limited;
    return handler();
  }

  function serveBdpmList(dataType: string) {
    return (req: Request): Response =>
      handleWithValidation(req, (params) =>
        Response.json(
          bdpmList(
            dataType,
            params.get('q') ?? undefined,
            params.get('page') ?? undefined,
            params.get('limit') ?? undefined
          ),
          { status: 200, headers: JSON_SECURITY_HEADERS }
        )
      );
  }

  function serveVetList(dataType: string) {
    return (req: Request): Response =>
      handleWithValidation(req, (params) =>
        Response.json(
          vetList(
            dataType,
            params.get('q') ?? undefined,
            params.get('page') ?? undefined,
            params.get('limit') ?? undefined
          ),
          { status: 200, headers: JSON_SECURITY_HEADERS }
        )
      );
  }

  const serveOptions: Parameters<typeof Bun.serve>[0] = {
    port,
    ...(hostname ? { hostname } : {}),
    routes: {
      '/': (req: Request) =>
        handleSimple(req, () => new Response(Bun.file(indexPath), { headers: SECURITY_HEADERS })),
      '/health': (req: Request) =>
        handleSimple(req, () => {
          const pretty = new URL(req.url).searchParams.get('pretty');
          const payload = buildHealthPayload();
          if (pretty === 'true' || pretty === '1') {
            return new Response(JSON.stringify(payload, null, 2), {
              status: 200,
              headers: PRETTY_JSON_HEADERS
            });
          }
          return Response.json(payload, { status: 200, headers: JSON_SECURITY_HEADERS });
        }),
      '/config': (req: Request) =>
        handleSimple(req, () =>
          Response.json(getRuntimeConfig(), { status: 200, headers: JSON_SECURITY_HEADERS })
        ),
      '/api-docs.json': (req: Request) =>
        handleSimple(req, () =>
          Response.json(swaggerSpecs, { status: 200, headers: JSON_SECURITY_HEADERS })
        ),

      '/api/medicaments/search': (req: Request) =>
        handleWithValidation(req, (params) => {
          const result = executeMedicamentSearchRoute({
            q: params.get('q') ?? undefined,
            page: params.get('page') ?? 1,
            limit: params.get('limit') ?? 50,
            source: params.get('source') ?? undefined,
            format: params.get('format') ?? undefined,
            detail: params.get('detail') ?? undefined,
            dosage: params.get('dosage') ?? undefined,
            forme: params.get('forme') ?? undefined,
            voie: params.get('voie') ?? undefined
          });
          if (result.markdown !== undefined) {
            return new Response(result.markdown, { status: result.status, headers: MARKDOWN_HEADERS });
          }
          return Response.json(result.json, { status: result.status, headers: JSON_SECURITY_HEADERS });
        }),
      '/api/medicaments/specialites': serveBdpmList('specialites'),
      '/api/medicaments/specialites/:cis': (req: Bun.BunRequest<'/api/medicaments/specialites/:cis'>) =>
        handleWithValidation(req, () => jsonResultResponse(getSpecialiteDetailResult(req.params.cis))),
      '/api/medicaments/presentations': serveBdpmList('presentations'),
      '/api/medicaments/compositions': serveBdpmList('compositions'),
      '/api/medicaments/groupes-generiques': serveBdpmList('generiques'),
      '/api/medicaments/conditions': serveBdpmList('conditions'),
      '/api/medicaments/substances': serveBdpmList('substances'),
      '/api/medicaments/avis-smr': (req: Request) =>
        handleWithValidation(req, (params) =>
          handleGuardedBdpmList(
            isHasAvisLoaded,
            'Les avis HAS (SMR/ASMR) ne sont pas chargés sur ce serveur (LOAD_HAS_AVIS=false).',
            'avis_smr',
            params
          )
        ),
      '/api/medicaments/avis-asmr': (req: Request) =>
        handleWithValidation(req, (params) =>
          handleGuardedBdpmList(
            isHasAvisLoaded,
            'Les avis HAS (SMR/ASMR) ne sont pas chargés sur ce serveur (LOAD_HAS_AVIS=false).',
            'avis_asmr',
            params
          )
        ),
      '/api/medicaments/interet-therapeutique-majeur': (req: Request) =>
        handleWithValidation(req, (params) =>
          handleGuardedBdpmList(
            isMitmLoaded,
            'Les MITM ne sont pas chargés sur ce serveur (LOAD_MITM=false).',
            'mitm',
            params
          )
        ),
      '/api/medicaments/disponibilite/alerts': (req: Request) =>
        handleWithValidation(req, (params) =>
          jsonResultResponse(getDisponibiliteAlertsResult(paramsToDisponibiliteQuery(params)))
        ),
      '/api/medicaments/disponibilite/alerts/:alertId': (
        req: Bun.BunRequest<'/api/medicaments/disponibilite/alerts/:alertId'>
      ) =>
        handleWithValidation(req, () =>
          jsonResultResponse(getDisponibiliteAlertDetailResult(req.params.alertId))
        ),
      '/api/medicaments/disponibilite': (req: Request) =>
        handleWithValidation(req, (params) =>
          jsonResultResponse(getDisponibiliteListResult(paramsToDisponibiliteQuery(params)))
        ),

      '/api/veterinaires/medicaments': serveVetList('medicaments'),
      '/api/veterinaires/medicaments/:num': (req: Bun.BunRequest<'/api/veterinaires/medicaments/:num'>) =>
        handleWithValidation(req, () => jsonResultResponse(getVeterinaireDetailResult(req.params.num))),
      '/api/veterinaires/compositions': serveVetList('compositions'),
      '/api/veterinaires/presentations': serveVetList('presentations')
    },
    fetch(req: Request): Response {
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
      }
      return Response.json({ error: 'Not Found' }, { status: 404, headers: JSON_SECURITY_HEADERS });
    }
  };

  activeServer = Bun.serve(serveOptions);
  return {
    server: activeServer,
    stop: async () => {
      rateLimiter?.dispose();
      await activeServer?.stop(true);
    }
  };
}

export type RunningBunServer = ManagedServerInstance<ReturnType<typeof Bun.serve>>;

let runningBunServer: RunningBunServer | null = null;

const startBunServer = singleFlight(async (options: BunServeOptions = {}): Promise<RunningBunServer> => {
  if (runningBunServer) return runningBunServer;
  let currentServer: ReturnType<typeof Bun.serve> | null = null;
  let disposeRateLimiter: (() => Promise<void>) | null = null;

  const startLifecycle = createServerLifecycle<ReturnType<typeof Bun.serve>>({
    listen: async () => {
      const { server, stop } = startBunHttpServer(options);
      currentServer = server;
      disposeRateLimiter = stop;
      return { server, close: stop };
    },
    onStop: () => {
      if (runningBunServer?.server === currentServer) runningBunServer = null;
    },
    logStartup: (port) => {
      const actualPort = currentServer?.port ?? port;
      console.log(`Serveur Bun.serve démarré sur le port ${actualPort}`);
      console.log(`Health check: http://localhost:${actualPort}/health`);
      console.log(`Spec OpenAPI: http://localhost:${actualPort}/api-docs.json`);
    }
  });

  const managed = await startLifecycle();
  if (!managed) return undefined as unknown as RunningBunServer;
  runningBunServer = {
    server: managed.server,
    stop: async () => {
      await managed.stop();
      if (disposeRateLimiter) await disposeRateLimiter();
      if (runningBunServer?.server === currentServer) runningBunServer = null;
    },
    refreshBdpm: managed.refreshBdpm,
    refreshVet: managed.refreshVet
  };
  return runningBunServer;
});

if ((import.meta as { main?: boolean }).main === true) {
  startBunServer();
}

export {
  startBunHttpServer,
  startBunServer,
  shouldRestartOnDataChange,
  reloadBdpmAfterChange,
  reloadVetAfterChange
};
