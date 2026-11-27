/**
 * The Board tab: a conversation's task board, the workspace's pipelines and
 * their runs, on one canvas, with the inspector, the step form and the run
 * monitor. It draws what a host sends and asks the host for every change; the
 * host side is `createBoardBackend` from `@cline/taskboard`, and the messages
 * between them are `@cline/taskboard/protocol`.
 *
 *   import { BoardViewer, windowMessageTransport } from "@cline/ui/components/board-viewer";
 *   import "@cline/ui/components/board-viewer.css";
 *
 * Needs `@xyflow/react` and `@dagrejs/dagre` (optional peers of this package).
 */

export { BoardViewer, type BoardViewerProps } from "./BoardViewer.js";
export {
	type BoardViewerTransport,
	readBoardText,
	readViewerMessage,
	type ViewerReply,
	windowMessageTransport,
} from "./model.js";
