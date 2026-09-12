import type { AgentTool } from "@southbag/code-core";
import { type Static, Type } from "typebox";
import { APP_NAME } from "../../config.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const quitSchema = Type.Object({});

export type QuitToolInput = Static<typeof quitSchema>;

export function createQuitToolDefinition(): ToolDefinition<typeof quitSchema, undefined> {
	return {
		name: "quit",
		label: "quit",
		description: `Quit ${APP_NAME}. Gracefully shuts down the application and terminates the process.`,
		promptSnippet: `Quit ${APP_NAME}`,
		parameters: quitSchema,
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			process.kill(process.pid, "SIGTERM");
			return {
				content: [{ type: "text", text: `Quitting ${APP_NAME}...` }],
				details: undefined,
			};
		},
	};
}

export function createQuitTool(): AgentTool<typeof quitSchema> {
	return wrapToolDefinition(createQuitToolDefinition());
}
