import { type AgentNodeRecord, agentNodeLabels, MAX_AGENT_NODES, PRIMARY_AGENT_NODE_ID } from "@shared/agent-nodes"
import { TabButton } from "../mcp/configuration/McpConfigurationView"

/**
 * The row of agent nodes, inside the Agents tab and above the provider form.
 *
 * Each tab is one complete agents configuration. Node1 is always there and
 * cannot be removed -- it is the Agents tab as it was before nodes existed, and
 * an empty Node1 still means "no agents", which is what the Agents toggle has
 * always said.
 *
 * The number on a tab is its position, not its name: removing Node4 of six
 * renders the last two as Node4 and Node5, while their ids -- and so their
 * stored configurations -- stay where they were. Which node a delegated agent
 * actually runs on is decided by the priority saved in that node's settings,
 * never by this order.
 *
 * The row wraps rather than scrolls: the settings panel can be narrow enough
 * for two tabs, and a tab that has to be scrolled to is a tab that gets
 * forgotten about.
 */
const AgentNodeTabs = ({
	nodes,
	selectedId,
	onSelect,
	onAdd,
	onRemove,
}: {
	nodes: readonly AgentNodeRecord[]
	selectedId: string
	onSelect: (id: string) => void
	onAdd: () => void
	onRemove: (id: string) => void
}) => {
	const labels = agentNodeLabels(nodes)
	const atCapacity = nodes.length >= MAX_AGENT_NODES

	return (
		<div className="flex flex-wrap gap-px mb-[10px] border-0 border-b border-solid border-(--vscode-panel-border)">
			{nodes.map((node) => {
				const isActive = node.id === selectedId
				const label = labels[node.id]
				return (
					<span className="inline-flex items-center" key={node.id}>
						<TabButton
							isActive={isActive}
							onClick={() => onSelect(node.id)}
							style={{ opacity: 1, cursor: "pointer" }}>
							<span className="inline-flex items-center gap-1">
								{label}
								{node.id === PRIMARY_AGENT_NODE_ID ? null : (
									<span
										aria-label={`Remove ${label}`}
										className="codicon codicon-trash text-[11px] opacity-70 hover:opacity-100"
										onClick={(event) => {
											// The tab is a button; without this the click
											// selects the node it is removing first.
											event.stopPropagation()
											onRemove(node.id)
										}}
										onKeyDown={(event) => {
											if (event.key === "Enter" || event.key === " ") {
												event.stopPropagation()
												event.preventDefault()
												onRemove(node.id)
											}
										}}
										role="button"
										tabIndex={0}
										title={`Remove ${label} and its configuration`}
									/>
								)}
							</span>
						</TabButton>
					</span>
				)
			})}
			<TabButton
				disabled={atCapacity}
				isActive={false}
				onClick={() => {
					if (!atCapacity) {
						onAdd()
					}
				}}
				style={{ opacity: atCapacity ? 0.4 : 1, cursor: atCapacity ? "default" : "pointer" }}>
				<span title={atCapacity ? `At most ${MAX_AGENT_NODES} nodes` : "Add a node"}>+</span>
			</TabButton>
		</div>
	)
}

export default AgentNodeTabs
