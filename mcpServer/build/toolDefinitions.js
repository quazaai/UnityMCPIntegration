import { z } from 'zod';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import path from 'path';
// Import handleFilesystemTool using ES module syntax instead of require
import { handleFilesystemTool } from './filesystemTools.js';
// File operation schemas - defined here to be used in tool definitions
export const ReadFileArgsSchema = z.object({
    path: z.string().describe('Path to the file to read. Can be absolute or relative to Unity project Assets folder. If empty, defaults to the Assets folder.'),
});
export const ReadMultipleFilesArgsSchema = z.object({
    paths: z.array(z.string()).describe('Array of file paths to read. Paths can be absolute or relative to Unity project Assets folder.'),
});
export const WriteFileArgsSchema = z.object({
    path: z.string().describe('Path to the file to write. Can be absolute or relative to Unity project Assets folder. If empty, defaults to the Assets folder.'),
    content: z.string().describe('Content to write to the file'),
});
export const EditOperation = z.object({
    oldText: z.string().describe('Text to search for - must match exactly'),
    newText: z.string().describe('Text to replace with')
});
export const EditFileArgsSchema = z.object({
    path: z.string().describe('Path to the file to edit. Can be absolute or relative to Unity project Assets folder. If empty, defaults to the Assets folder.'),
    edits: z.array(EditOperation).describe('Array of edit operations to apply'),
    dryRun: z.boolean().default(false).describe('Preview changes using git-style diff format')
});
export const ListDirectoryArgsSchema = z.object({
    path: z.string().describe('Path to the directory to list. Can be absolute or relative to Unity project Assets folder. If empty, defaults to the Assets folder. Example: "Scenes" will list all files in the Assets/Scenes directory.'),
});
export const DirectoryTreeArgsSchema = z.object({
    path: z.string().describe('Path to the directory to get tree of. Can be absolute or relative to Unity project Assets folder. If empty, defaults to the Assets folder. Example: "Prefabs" will show the tree for Assets/Prefabs.'),
    maxDepth: z.number().optional().default(5).describe('Maximum depth to traverse'),
});
export const SearchFilesArgsSchema = z.object({
    path: z.string().describe('Path to search from. Can be absolute or relative to Unity project Assets folder. If empty, defaults to the Assets folder. Example: "Scripts" will search within Assets/Scripts.'),
    pattern: z.string().describe('Pattern to search for'),
    excludePatterns: z.array(z.string()).optional().default([]).describe('Patterns to exclude')
});
export const GetFileInfoArgsSchema = z.object({
    path: z.string().describe('Path to the file to get info for. Can be absolute or relative to Unity project Assets folder. If empty, defaults to the Assets folder.'),
});
export const FindAssetsByTypeArgsSchema = z.object({
    assetType: z.string().describe('Type of assets to find (e.g., "Material", "Prefab", "Scene")'),
    searchPath: z.string().optional().default("Assets").describe('Directory to search in. Can be absolute or relative to Unity project Assets folder. Example: "Materials" will search in Assets/Materials.'),
});
export const ListScriptsArgsSchema = z.object({
    path: z.string().optional().default("Scripts").describe('Path to look for scripts in. Can be absolute or relative to Unity project Assets folder. If empty, defaults to the Assets/Scripts folder.'),
});
/**
 * Registers available Unity Editor and filesystem tools with the MCP server and configures tool request handling.
 *
 * This function determines the project root from the UNITY_PROJECT_PATH environment variable (or defaults
 * to the current working directory) and registers a set of tools—each defined with its name, description,
 * category, tags, and input schema—for both Unity Editor operations and filesystem interactions.
 * It also sets up a request handler that routes tool invocation requests based on the tool name,
 * handling special cases such as connection verification, filesystem operations (via a dedicated handler),
 * and Unity-specific commands. If the Unity Editor is not connected when required, it throws an McpError.
 *
 * @remark Tools like "verify_connection" are processed even if the Unity Editor is not connected, while other
 * Unity-specific tools require an active connection and perform additional error handling.
 */
export function registerTools(server, wsHandler) {
    // Determine project root path from environment variable or default to parent of Assets folder
    const projectPath = process.env.UNITY_PROJECT_PATH || path.resolve(process.cwd());
    // List all available tools (both Unity and filesystem tools)
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            // Unity Editor tools
            {
                name: 'get_current_scene_info',
                description: 'Retrieve information about the current scene in Unity Editor with configurable detail level',
                category: 'Editor State',
                tags: ['unity', 'editor', 'scene'],
                inputSchema: {
                    type: 'object',
                    properties: {
                        detailLevel: {
                            type: 'string',
                            enum: ['RootObjectsOnly', 'FullHierarchy'],
                            description: 'RootObjectsOnly: Returns just root GameObjects. FullHierarchy: Returns complete hierarchy with all children.',
                            default: 'RootObjectsOnly'
                        }
                    },
                    additionalProperties: false
                },
                returns: {
                    type: 'object',
                    description: 'Returns information about the current scene and its hierarchy based on requested detail level'
                }
            },
            {
                name: 'get_game_objects_info',
                description: 'Retrieve detailed information about specific GameObjects in the current scene',
                category: 'Editor State',
                tags: ['unity', 'editor', 'gameobjects'],
                inputSchema: {
                    type: 'object',
                    properties: {
                        instanceIDs: {
                            type: 'array',
                            items: {
                                type: 'number'
                            },
                            description: 'Array of GameObject instance IDs to get information for',
                            minItems: 1
                        },
                        detailLevel: {
                            type: 'string',
                            enum: ['BasicInfo', 'IncludeComponents', 'IncludeChildren', 'IncludeComponentsAndChildren'],
                            description: 'BasicInfo: Basic GameObject information. IncludeComponents: Includes component details. IncludeChildren: Includes child GameObjects. IncludeComponentsAndChildren: Includes both components and a full hierarchy with components on children.',
                            default: 'IncludeComponents'
                        }
                    },
                    required: ['instanceIDs'],
                    additionalProperties: false
                },
                returns: {
                    type: 'object',
                    description: 'Returns detailed information about the requested GameObjects'
                }
            },
            {
                name: 'execute_editor_command',
                description: 'Execute C# code directly in the Unity Editor - code is executed immediately in the editor context, not as a MonoBehaviour script',
                category: 'Editor Control',
                tags: ['unity', 'editor', 'command', 'c#'],
                inputSchema: {
                    type: 'object',
                    properties: {
                        code: {
                            type: 'string',
                            description: 'Raw C# code to execute immediately in the Unity Editor. DO NOT include namespace declarations, class definitions or Start/Update methods. Write code that executes directly like a function body. The following namespaces are automatically available: UnityEngine, UnityEditor, System, System.Linq, System.Collections, and System.Collections.Generic. The code should return a value if you want to get results back.',
                            minLength: 1
                        }
                    },
                    required: ['code'],
                    additionalProperties: false
                },
                returns: {
                    type: 'object',
                    description: 'Returns the execution result, execution time, and status'
                }
            },
            {
                name: 'get_logs',
                description: 'Retrieve Unity Editor logs with filtering options',
                category: 'Debugging',
                tags: ['unity', 'editor', 'logs', 'debugging'],
                inputSchema: {
                    type: 'object',
                    properties: {
                        types: {
                            type: 'array',
                            items: {
                                type: 'string',
                                enum: ['Log', 'Warning', 'Error', 'Exception']
                            },
                            description: 'Filter logs by type'
                        },
                        count: {
                            type: 'number',
                            description: 'Maximum number of log entries to return',
                            minimum: 1,
                            maximum: 1000
                        },
                        fields: {
                            type: 'array',
                            items: {
                                type: 'string',
                                enum: ['message', 'stackTrace', 'logType', 'timestamp']
                            },
                            description: 'Specify which fields to include in the output'
                        },
                        messageContains: {
                            type: 'string',
                            description: 'Filter logs by message content'
                        },
                        stackTraceContains: {
                            type: 'string',
                            description: 'Filter logs by stack trace content'
                        },
                        timestampAfter: {
                            type: 'string',
                            description: 'Filter logs after this ISO timestamp'
                        },
                        timestampBefore: {
                            type: 'string',
                            description: 'Filter logs before this ISO timestamp'
                        }
                    },
                    additionalProperties: false
                },
                returns: {
                    type: 'array',
                    description: 'Returns an array of log entries matching the specified filters'
                }
            },
            {
                name: 'verify_connection',
                description: 'Verify that the MCP server has an active connection to Unity Editor',
                category: 'Connection',
                tags: ['unity', 'editor', 'connection'],
                inputSchema: {
                    type: 'object',
                    properties: {},
                    additionalProperties: false
                },
                returns: {
                    type: 'object',
                    description: 'Returns connection status information'
                }
            },
            {
                name: 'get_editor_state',
                description: 'Get the current Unity Editor state including project information',
                category: 'Editor State',
                tags: ['unity', 'editor', 'project'],
                inputSchema: {
                    type: 'object',
                    properties: {},
                    additionalProperties: false
                },
                returns: {
                    type: 'object',
                    description: 'Returns detailed information about the current Unity Editor state, project settings, and environment'
                }
            },
            // Filesystem tools - defined alongside Unity tools
            {
                name: "read_file",
                description: "Read the contents of a file from the Unity project. Paths are relative to the project's Assets folder unless specified as absolute. For example, use 'Scenes/MainScene.unity' to read Assets/Scenes/MainScene.unity.",
                category: "Filesystem",
                tags: ['unity', 'filesystem', 'file'],
                inputSchema: zodToJsonSchema(ReadFileArgsSchema),
            },
            {
                name: "read_multiple_files",
                description: "Read the contents of multiple files from the Unity project simultaneously.",
                category: "Filesystem",
                tags: ['unity', 'filesystem', 'file', 'batch'],
                inputSchema: zodToJsonSchema(ReadMultipleFilesArgsSchema),
            },
            {
                name: "write_file",
                description: "Create a new file or completely overwrite an existing file in the Unity project.",
                category: "Filesystem",
                tags: ['unity', 'filesystem', 'file', 'write'],
                inputSchema: zodToJsonSchema(WriteFileArgsSchema),
            },
            {
                name: "edit_file",
                description: "Make precise edits to a text file in the Unity project. Returns a git-style diff showing changes.",
                category: "Filesystem",
                tags: ['unity', 'filesystem', 'file', 'edit'],
                inputSchema: zodToJsonSchema(EditFileArgsSchema),
            },
            {
                name: "list_directory",
                description: "Get a listing of all files and directories in a specified path in the Unity project. Paths are relative to the Assets folder unless absolute. For example, use 'Scenes' to list all files in Assets/Scenes directory. Use empty string to list the Assets folder.",
                category: "Filesystem",
                tags: ['unity', 'filesystem', 'directory', 'list'],
                inputSchema: zodToJsonSchema(ListDirectoryArgsSchema),
            },
            {
                name: "directory_tree",
                description: "Get a recursive tree view of files and directories in the Unity project as a JSON structure.",
                category: "Filesystem",
                tags: ['unity', 'filesystem', 'directory', 'tree'],
                inputSchema: zodToJsonSchema(DirectoryTreeArgsSchema),
            },
            {
                name: "search_files",
                description: "Recursively search for files and directories matching a pattern in the Unity project.",
                category: "Filesystem",
                tags: ['unity', 'filesystem', 'search'],
                inputSchema: zodToJsonSchema(SearchFilesArgsSchema),
            },
            {
                name: "get_file_info",
                description: "Retrieve detailed metadata about a file or directory in the Unity project.",
                category: "Filesystem",
                tags: ['unity', 'filesystem', 'file', 'metadata'],
                inputSchema: zodToJsonSchema(GetFileInfoArgsSchema),
            },
            {
                name: "find_assets_by_type",
                description: "Find all Unity assets of a specified type (e.g., Material, Prefab, Script) in the project.",
                category: "Filesystem",
                tags: ['unity', 'filesystem', 'assets', 'search'],
                inputSchema: zodToJsonSchema(FindAssetsByTypeArgsSchema),
            },
            {
                name: "list_scripts",
                description: "List all C# script files in the project, useful for understanding the codebase structure.",
                category: "Filesystem",
                tags: ['unity', 'filesystem', 'scripts', 'list'],
                inputSchema: zodToJsonSchema(ListScriptsArgsSchema),
            }
        ],
    }));
    // Handle tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        // Special case for verify_connection which should work even if not connected
        if (name === 'verify_connection') {
            try {
                const isConnected = wsHandler.isConnected();
                // Always request fresh editor state if connected
                if (isConnected) {
                    wsHandler.requestEditorState();
                }
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify({
                                connected: isConnected,
                                timestamp: new Date().toISOString(),
                                message: isConnected
                                    ? 'Unity Editor is connected'
                                    : 'Unity Editor is not connected. Please ensure the Unity Editor is running with the MCP plugin.'
                            }, null, 2)
                        }]
                };
            }
            catch (error) {
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify({
                                connected: false,
                                timestamp: new Date().toISOString(),
                                message: 'Error checking connection status',
                                error: error instanceof Error ? error.message : 'Unknown error'
                            }, null, 2)
                        }]
                };
            }
        }
        // Check if this is a filesystem tool
        const filesystemTools = [
            "read_file", "read_multiple_files", "write_file", "edit_file",
            "list_directory", "directory_tree", "search_files", "get_file_info",
            "find_assets_by_type", "list_scripts"
        ];
        if (filesystemTools.includes(name)) {
            try {
                return await handleFilesystemTool(name, args, projectPath);
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return {
                    content: [{ type: "text", text: `Error: ${errorMessage}` }],
                    isError: true,
                };
            }
        }
        // For all other tools (Unity-specific), verify connection first
        if (!wsHandler.isConnected()) {
            throw new McpError(ErrorCode.InternalError, 'Unity Editor is not connected. Please first verify the connection using the verify_connection tool, ' +
                'and ensure the Unity Editor is running with the MCP plugin and that the WebSocket connection is established.');
        }
        switch (name) {
            case 'get_editor_state': {
                try {
                    // Always request a fresh editor state before returning
                    wsHandler.requestEditorState();
                    // Wait a moment for the response to arrive
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    // Return the current editor state
                    const editorState = wsHandler.getEditorState();
                    return {
                        content: [{
                                type: 'text',
                                text: JSON.stringify(editorState, null, 2)
                            }]
                    };
                }
                catch (error) {
                    throw new McpError(ErrorCode.InternalError, `Failed to get editor state: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
            }
            case 'get_current_scene_info': {
                try {
                    const detailLevel = args?.detailLevel || 'RootObjectsOnly';
                    // Send request to Unity and wait for response
                    const sceneInfo = await wsHandler.requestSceneInfo(detailLevel);
                    return {
                        content: [{
                                type: 'text',
                                text: JSON.stringify(sceneInfo, null, 2)
                            }]
                    };
                }
                catch (error) {
                    throw new McpError(ErrorCode.InternalError, `Failed to get scene info: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
            }
            case 'get_game_objects_info': {
                try {
                    if (!args?.instanceIDs || !Array.isArray(args.instanceIDs)) {
                        throw new McpError(ErrorCode.InvalidParams, 'instanceIDs array is required');
                    }
                    const instanceIDs = args.instanceIDs;
                    const detailLevel = args?.detailLevel || 'IncludeComponents';
                    // Send request to Unity and wait for response
                    const gameObjectsInfo = await wsHandler.requestGameObjectsInfo(instanceIDs, detailLevel);
                    return {
                        content: [{
                                type: 'text',
                                text: JSON.stringify(gameObjectsInfo, null, 2)
                            }]
                    };
                }
                catch (error) {
                    throw new McpError(ErrorCode.InternalError, `Failed to get GameObject info: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
            }
            case 'execute_editor_command': {
                try {
                    if (!args?.code) {
                        throw new McpError(ErrorCode.InvalidParams, 'The code parameter is required');
                    }
                    const startTime = Date.now();
                    const result = await wsHandler.executeEditorCommand(args.code);
                    const executionTime = Date.now() - startTime;
                    return {
                        content: [{
                                type: 'text',
                                text: JSON.stringify({
                                    result,
                                    executionTime: `${executionTime}ms`,
                                    status: 'success'
                                }, null, 2)
                            }]
                    };
                }
                catch (error) {
                    if (error instanceof Error) {
                        if (error.message.includes('timed out')) {
                            throw new McpError(ErrorCode.InternalError, 'Command execution timed out. This may indicate a long-running operation or an issue with the Unity Editor.');
                        }
                        if (error.message.includes('NullReferenceException')) {
                            throw new McpError(ErrorCode.InvalidParams, 'The code attempted to access a null object. Please check that all GameObject references exist.');
                        }
                        if (error.message.includes('not connected')) {
                            throw new McpError(ErrorCode.InternalError, 'Unity Editor connection was lost during command execution. Please verify the connection and try again.');
                        }
                    }
                    throw new McpError(ErrorCode.InternalError, `Failed to execute command: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
            }
            case 'get_logs': {
                try {
                    const options = {
                        types: args?.types,
                        count: args?.count,
                        fields: args?.fields,
                        messageContains: args?.messageContains,
                        stackTraceContains: args?.stackTraceContains,
                        timestampAfter: args?.timestampAfter,
                        timestampBefore: args?.timestampBefore
                    };
                    const logs = wsHandler.getLogEntries(options);
                    return {
                        content: [{
                                type: 'text',
                                text: JSON.stringify(logs, null, 2)
                            }]
                    };
                }
                catch (error) {
                    throw new McpError(ErrorCode.InternalError, `Failed to retrieve logs: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
            }
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
    });
}
