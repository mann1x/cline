import {
	type AgentNodeRecord,
	addAgentNode,
	agentNodeLabels,
	MAX_AGENT_NODE_PRIORITY,
	MIN_AGENT_NODE_PRIORITY,
	PRIMARY_AGENT_NODE_ID,
	parseAgentNodes,
	removeAgentNode,
	serializeAgentNodes,
	setAgentNodePriority,
	setAgentNodeSnapshot,
} from "@shared/agent-nodes"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { useCallback, useMemo, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import AgentNodeTabs from "./AgentNodeTabs"
import ScopedModelTab from "./ScopedModelTab"

/**
 * The API configuration panel, pointed at the models delegated agents run on.
 *
 * Subagents and teammates inherited the session's whole connection config --
 * provider, model, sampler, and the context window with it -- so there was no
 * way to run a team of small agents under a large lead, and no way to give them
 * a window of their own. Everything about how a tab holds its own configuration
 * lives in `ScopedModelTab`; this says which configuration, and how many.
 *
 * Nodes are the backbone of the feature rather than an extra: a delegated agent
 * runs on one of them, and Node1 left empty still means no agents at all. More
 * than one node exists so a fan-out can be spread across endpoints -- a fast
 * local model first, a second machine behind it -- with the priority saved on
 * each node deciding the order, not the order of the tabs.
 *
 * Node1's configuration stays in `agentsModeApiConfiguration` so nothing needs
 * migrating; the rest live in the `agentNodes` list beside their priorities.
 * Switching node remounts the panel (`key`), because the panel holds the
 * snapshot it is editing and would otherwise carry one node's edits into the
 * next.
 */
const AgentsModelTab = () => {
	const { agentsModeApiConfiguration, agentNodes } = useExtensionState()
	const nodes = useMemo(() => parseAgentNodes(agentNodes), [agentNodes])
	const [selectedId, setSelectedId] = useState<string>(PRIMARY_AGENT_NODE_ID)

	// A node removed while it was showing leaves nothing selected; fall back to
	// Node1, which is always there.
	const activeId = nodes.some((node) => node.id === selectedId) ? selectedId : PRIMARY_AGENT_NODE_ID
	const active = nodes.find((node) => node.id === activeId) ?? nodes[0]
	const labels = agentNodeLabels(nodes)

	const persistNodes = useCallback(async (next: readonly AgentNodeRecord[]) => {
		await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ agentNodes: serializeAgentNodes(next) }))
	}, [])

	const handleAdd = useCallback(async () => {
		// Ids are minted from the clock rather than the count, so a node added
		// after one was removed can never reuse a departed node's id and
		// inherit its profile.
		const id = `node-${Date.now().toString(36)}`
		const next = addAgentNode(nodes, id)
		setSelectedId(id)
		await persistNodes(next)
	}, [nodes, persistNodes])

	const handleRemove = useCallback(
		async (id: string) => {
			if (id === activeId) {
				setSelectedId(PRIMARY_AGENT_NODE_ID)
			}
			await persistNodes(removeAgentNode(nodes, id))
		},
		[activeId, nodes, persistNodes],
	)

	const handlePriority = useCallback(
		async (value: string) => {
			await persistNodes(setAgentNodePriority(nodes, activeId, value))
		},
		[activeId, nodes, persistNodes],
	)

	const writeNodeSnapshot = useCallback(
		async (json: string) => {
			await persistNodes(setAgentNodeSnapshot(nodes, activeId, json))
		},
		[activeId, nodes, persistNodes],
	)

	const isPrimary = activeId === PRIMARY_AGENT_NODE_ID

	return (
		<div>
			<AgentNodeTabs
				nodes={nodes}
				onAdd={handleAdd}
				onRemove={handleRemove}
				onSelect={setSelectedId}
				selectedId={activeId}
			/>

			<div className="mb-3">
				<label className="block text-xs mb-1" htmlFor="agent-node-priority">
					Priority
				</label>
				<input
					className="w-16 bg-(--vscode-input-background) text-(--vscode-input-foreground) border border-solid border-(--vscode-input-border) rounded-sm px-1 py-0.5"
					id="agent-node-priority"
					max={MAX_AGENT_NODE_PRIORITY}
					min={MIN_AGENT_NODE_PRIORITY}
					onChange={(event) => void handlePriority(event.target.value)}
					type="number"
					value={active?.priority ?? MIN_AGENT_NODE_PRIORITY}
				/>
				<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
					1 is the highest. Agents are placed on the free nodes of the best priority they can get, taking turns between
					nodes that share one; a lower priority is used only when nothing above it has room. When every node is busy
					the next agent waits rather than failing.
				</p>
			</div>

			<ScopedModelTab
				key={activeId}
				scopeKey={`agentsModeApiConfiguration::${activeId}`}
				setting="agentsModeApiConfiguration"
				storedSnapshot={isPrimary ? agentsModeApiConfiguration : (active?.snapshot ?? "")}
				writeSnapshot={isPrimary ? undefined : writeNodeSnapshot}
			/>

			{isPrimary ? null : (
				<p className="text-xs mt-2 text-(--vscode-descriptionForeground)">
					{labels[activeId]} is a node of its own: its provider, model, context window and sampler are separate from
					Node1's, and only the agents placed on it use them.
				</p>
			)}
		</div>
	)
}

export default AgentsModelTab
