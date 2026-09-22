import { readOpencotiStatus } from "@cline/llms"
import { StringRequest } from "@/shared/proto/cline/common"
import { PolykvStatusResponse } from "@/shared/proto/cline/models"
import { type ProviderCatalogController, parseProviderIdRequest } from "./providerCatalogShared"

/**
 * An opencoti server's live PolyKV state, for the settings panel.
 *
 * The base URL comes from the stored provider config rather than the request,
 * so the panel shows the server it is configured against and cannot be pointed
 * somewhere else from the webview.
 *
 * The read touches `/props`, `/polykv/pools` and `/polykv/tps` always, and
 * `/capacity` only when the server advertises `capacity_readonly_v1`.
 *
 * That condition is the whole of it. On the published c7 engine every GET of
 * `/capacity` folds the settle and bias EWMAs the admission projection is built
 * from, so a panel that refreshed would corrupt the very measurement it was
 * drawing -- which is why `kv_headroom_pct` and the SWA arm, which live only
 * there, were simply absent. The flag says the plain GET is read-only and the
 * fold has moved behind `?fold=1`. Without it they stay absent rather than
 * being guessed at.
 */
export async function readPolykvStatus(
	controller: ProviderCatalogController,
	request: StringRequest,
): Promise<PolykvStatusResponse> {
	const providerId = parseProviderIdRequest(request.value, "value")
	const config = controller.getProviderConfigStore().read(providerId)
	const status = await readOpencotiStatus(config.baseUrl)
	return PolykvStatusResponse.create({
		reachable: status.reachable,
		release: status.release,
		poolsEnabled: status.poolsEnabled,
		elastic: status.elastic,
		elasticReason: status.elasticReason,
		slotsLive: status.slotsLive,
		slotsMax: status.slotsMax,
		vramFreeMib: status.vramFreeMib,
		tpsFloor: status.tpsFloor,
		grows: status.grows,
		shrinks: status.shrinks,
		poolsMax: status.poolsMax,
		treeDepth: status.treeDepth,
		kvHeadroomPct: status.kvHeadroomPct,
		kvCellsFree: status.kvCellsFree,
		kvCellsTotal: status.kvCellsTotal,
		swaActive: status.swaActive,
		// `null` is the engine declining to state a number it does not have.
		// proto3 has no null, and `0` here would read as "no room left", so an
		// unstated figure stays unset.
		swaCellsFree: status.swaCellsFree ?? undefined,
		swaCellsTotal: status.swaCellsTotal ?? undefined,
		pools: status.pools.map((pool) => ({
			poolId: pool.poolId,
			parent: pool.parent,
			branchPos: pool.branchPos,
			prefixLen: pool.prefixLen,
			pinned: pool.pinned,
			ephemeral: pool.ephemeral,
			orphanedPin: pool.orphanedPin,
			sourceSession: pool.sourceSession,
			children: pool.children,
		})),
		sessions: status.sessions.map((session) => ({
			sessionId: session.sessionId,
			tps: session.tps,
			active: session.active,
			ctxUsed: session.ctxUsed,
			ctxTotal: session.ctxTotal,
			poolId: session.poolId,
			allocKey: session.allocKey,
		})),
	})
}
