import fs from 'fs/promises';
import path from 'path';
import { createTwoFilesPatch } from 'diff';
import { minimatch } from 'minimatch';
import { ReadFileArgsSchema, ReadMultipleFilesArgsSchema, WriteFileArgsSchema, EditFileArgsSchema, ListDirectoryArgsSchema, DirectoryTreeArgsSchema, SearchFilesArgsSchema, GetFileInfoArgsSchema, FindAssetsByTypeArgsSchema, ListScriptsArgsSchema } from './toolDefinitions.js';
// Helper functions
/**
 * Validates and normalizes a file path, ensuring it remains within the specified asset root.
 *
 * The function first treats empty or quote-only paths as a request for the asset root. It then cleans the path
 * by removing extraneous quotes and escape characters, normalizes it, and handles relative paths by joining them with
 * the asset root. For absolute paths that do not start with the asset root, it attempts to resolve them as relative paths.
 * If the final resolved path escapes the asset root directory, an error is thrown.
 *
 * @param {string} requestedPath - The user-provided file path, which may include extraneous characters or be empty.
 * @param {string} assetRootPath - The base directory that the resolved path must remain within.
 * @returns {Promise<string>} A promise that resolves to the validated and normalized absolute file path.
 *
 * @throws {Error} If the resolved path is outside the asset root directory.
 */
async function validatePath(requestedPath, assetRootPath) {
    // If path is empty or just quotes, use the asset root path directly
    if (!requestedPath || requestedPath.trim() === '' || requestedPath.trim() === '""' || requestedPath.trim() === "''") {
        return assetRootPath;
    }
    // Clean the path to remove any unexpected quotes or escape characters
    let cleanPath = requestedPath.replace(/['"\\]/g, '');
    // Handle empty path after cleaning
    if (!cleanPath || cleanPath.trim() === '') {
        return assetRootPath;
    }
    // Normalize path to handle both Windows and Unix-style paths
    const normalized = path.normalize(cleanPath);
    // For relative paths, join with asset root path
    // Only check for absolute paths using path.isAbsolute - all other paths are considered relative
    let absolute;
    if (path.isAbsolute(normalized)) {
        absolute = normalized;
        // Additional check: if the absolute path is outside the project and doesn't exist,
        // try treating it as a relative path first
        if (!absolute.startsWith(assetRootPath)) {
            const tryRelative = path.join(assetRootPath, normalized);
            try {
                await fs.access(tryRelative);
                // If we can access it as a relative path, use that instead
                absolute = tryRelative;
            }
            catch {
                // If we can't access it as a relative path either, keep the original absolute path
                // and let the next check handle the potential error
            }
        }
    }
    else {
        absolute = path.join(assetRootPath, normalized);
    }
    const resolvedPath = path.resolve(absolute);
    // Ensure we don't escape out of the Unity project folder
    // Special case for empty path: it should always resolve to the project root
    if (!resolvedPath.startsWith(assetRootPath) && requestedPath.trim() !== '') {
        throw new Error(`Access denied: Path ${requestedPath} is outside the Unity project directory`);
    }
    return resolvedPath;
}
/**
 * Retrieves metadata for the specified file.
 *
 * This asynchronous function obtains file statistics including size, creation,
 * modification, and access times, as well as its permissions. It also indicates whether
 * the provided path refers to a file or a directory.
 *
 * @param {string} filePath - The path to the file or directory.
 * @returns {Promise<Object>} An object containing:
 *   - size {number}: The file size in bytes.
 *   - created {Date}: The file's creation time.
 *   - modified {Date}: The last modification time.
 *   - accessed {Date}: The last access time.
 *   - isDirectory {boolean}: True if the path is a directory.
 *   - isFile {boolean}: True if the path is a file.
 *   - permissions {string}: The file's permissions as the last three octal digits (e.g., "644").
 *
 * @throws {Error} If retrieving file statistics fails, such as when the file does not exist.
 */
async function getFileStats(filePath) {
    const stats = await fs.stat(filePath);
    return {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        permissions: stats.mode.toString(8).slice(-3),
    };
}
/**
 * Recursively searches for files and directories whose names include the specified pattern,
 * while excluding paths that match any provided glob patterns.
 *
 * Starting at the given root directory, this asynchronous function traverses the directory tree and:
 * - Computes the relative path for each entry to check against the exclusion patterns.
 * - Performs a case-insensitive check to see if the entry's name contains the specified search pattern.
 * - Recursively explores directories that are not excluded.
 * Any errors encountered during traversal are silently ignored to allow the search to continue.
 *
 * @param {string} rootPath - The directory to begin the search.
 * @param {string} pattern - The substring to match within file and directory names (case-insensitive).
 * @param {string[]} [excludePatterns=[]] - Optional array of glob patterns; paths matching these patterns are skipped.
 * @returns {Promise<string[]>} A promise that resolves to an array of paths for entries that match the search pattern.
 */
async function searchFiles(rootPath, pattern, excludePatterns = []) {
    const results = [];
    async function search(currentPath) {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);
            try {
                // Check if path matches any exclude pattern
                const relativePath = path.relative(rootPath, fullPath);
                const shouldExclude = excludePatterns.some(pattern => {
                    const globPattern = pattern.includes('*') ? pattern : `**/${pattern}/**`;
                    return minimatch(relativePath, globPattern, { dot: true });
                });
                if (shouldExclude) {
                    continue;
                }
                if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
                    results.push(fullPath);
                }
                if (entry.isDirectory()) {
                    await search(fullPath);
                }
            }
            catch (error) {
                // Skip invalid paths during search
                continue;
            }
        }
    }
    await search(rootPath);
    return results;
}
/**
 * Normalizes Windows-style carriage return and newline sequences to Unix-style newlines.
 *
 * Replaces all occurrences of "\r\n" in the provided text with "\n" to ensure consistent line endings.
 *
 * @param {string} text - The text to normalize.
 * @returns {string} The text with normalized Unix-style line endings.
 */
function normalizeLineEndings(text) {
    return text.replace(/\r\n/g, '\n');
}
/**
 * Generates a unified diff patch showing the differences between the original and new file content.
 *
 * This function first normalizes line endings in both inputs to guarantee a consistent diff format,
 * then creates a unified diff patch using the provided file identifier for header annotations.
 *
 * @param {string} originalContent - The original file content.
 * @param {string} newContent - The updated file content.
 * @param {string} [filepath='file'] - The file identifier used in the diff header.
 * @returns {string} A unified diff string representing the changes between the two versions of content.
 */
function createUnifiedDiff(originalContent, newContent, filepath = 'file') {
    // Ensure consistent line endings for diff
    const normalizedOriginal = normalizeLineEndings(originalContent);
    const normalizedNew = normalizeLineEndings(newContent);
    return createTwoFilesPatch(filepath, filepath, normalizedOriginal, normalizedNew, 'original', 'modified');
}
/**
 * Applies a series of text edits to a file and returns a formatted unified diff of the changes.
 *
 * This asynchronous function reads the content from the specified file, normalizes its line endings,
 * and sequentially applies each edit. Each edit specifies an "oldText" to search for and a "newText"
 * to substitute. The function first attempts an exact match; if not found, it then performs a
 * flexible, line-by-line replacement that preserves the file's indentation. If an edit's old text
 * cannot be found, an error is thrown.
 *
 * After applying all edits, a unified diff is generated to represent the changes. The diff is
 * formatted within a code block that adapts the number of backticks based on its content. When
 * dryRun is false (the default), the modified content is written back to the file; otherwise, no
 * file write occurs.
 *
 * @param {string} filePath - The path to the file to be edited.
 * @param {Array<{oldText: string, newText: string}>} edits - An array of edits describing the text to replace and its replacement.
 * @param {boolean} [dryRun=false] - If true, simulates the edits without saving changes to the file.
 * @returns {Promise<string>} A formatted unified diff of the changes applied.
 *
 * @throws {Error} If an edit's old text cannot be located in the file content.
 */
async function applyFileEdits(filePath, edits, dryRun = false) {
    // Read file content and normalize line endings
    const content = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));
    // Apply edits sequentially
    let modifiedContent = content;
    for (const edit of edits) {
        const normalizedOld = normalizeLineEndings(edit.oldText);
        const normalizedNew = normalizeLineEndings(edit.newText);
        // If exact match exists, use it
        if (modifiedContent.includes(normalizedOld)) {
            modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
            continue;
        }
        // Otherwise, try line-by-line matching with flexibility for whitespace
        const oldLines = normalizedOld.split('\n');
        const contentLines = modifiedContent.split('\n');
        let matchFound = false;
        for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
            const potentialMatch = contentLines.slice(i, i + oldLines.length);
            // Compare lines with normalized whitespace
            const isMatch = oldLines.every((oldLine, j) => {
                const contentLine = potentialMatch[j];
                return oldLine.trim() === contentLine.trim();
            });
            if (isMatch) {
                // Preserve original indentation of first line
                const originalIndent = contentLines[i].match(/^\s*/)?.[0] || '';
                const newLines = normalizedNew.split('\n').map((line, j) => {
                    if (j === 0)
                        return originalIndent + line.trimStart();
                    // For subsequent lines, try to preserve relative indentation
                    const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || '';
                    const newIndent = line.match(/^\s*/)?.[0] || '';
                    if (oldIndent && newIndent) {
                        const relativeIndent = newIndent.length - oldIndent.length;
                        return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
                    }
                    return line;
                });
                contentLines.splice(i, oldLines.length, ...newLines);
                modifiedContent = contentLines.join('\n');
                matchFound = true;
                break;
            }
        }
        if (!matchFound) {
            throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
        }
    }
    // Create unified diff
    const diff = createUnifiedDiff(content, modifiedContent, filePath);
    // Format diff with appropriate number of backticks
    let numBackticks = 3;
    while (diff.includes('`'.repeat(numBackticks))) {
        numBackticks++;
    }
    const formattedDiff = `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;
    if (!dryRun) {
        await fs.writeFile(filePath, modifiedContent, 'utf-8');
    }
    return formattedDiff;
}
/**
 * Recursively constructs a tree representation of the directory structure.
 *
 * This asynchronous function reads the contents of the directory at the specified
 * path, validates it against the asset root, and recursively processes subdirectories
 * up to the specified maximum depth. When the maximum depth is reached, it returns a
 * stub entry to indicate that further subdirectories exist.
 *
 * @param {string} currentPath - The starting directory path to build the tree from, typically relative to the asset root.
 * @param {string} assetRootPath - The root directory used to validate and resolve the current path.
 * @param {number} [maxDepth=5] - The maximum depth the function will traverse.
 * @param {number} [currentDepth=0] - The current depth level during recursion (used internally).
 * @returns {Promise<Array<Object>>} A promise that resolves to an array representing the directory tree. Each object includes a "name" and a "type" (either "file" or "directory"), and directory objects may include a "children" property with nested entries.
 */
async function buildDirectoryTree(currentPath, assetRootPath, maxDepth = 5, currentDepth = 0) {
    if (currentDepth >= maxDepth) {
        return [{ name: "...", type: "directory" }];
    }
    const validPath = await validatePath(currentPath, assetRootPath);
    const entries = await fs.readdir(validPath, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
        const entryData = {
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file'
        };
        if (entry.isDirectory()) {
            const subPath = path.join(currentPath, entry.name);
            entryData.children = await buildDirectoryTree(subPath, assetRootPath, maxDepth, currentDepth + 1);
        }
        result.push(entryData);
    }
    return result;
}
/**
 * Determines the Unity asset type based on the file extension.
 *
 * Extracts the file extension from the provided file path, converts it to lower case,
 * and returns a matching asset type according to predefined mapping. If the extension is not recognized,
 * the function returns "Other".
 *
 * @param {string} filePath - The file path from which the asset type is derived.
 * @returns {string} The Unity asset type (e.g., "Scene", "Prefab", "Texture") or "Other" if unrecognized.
 */
function getUnityAssetType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    // Common Unity asset types
    const assetTypes = {
        '.unity': 'Scene',
        '.prefab': 'Prefab',
        '.mat': 'Material',
        '.fbx': 'Model',
        '.cs': 'Script',
        '.anim': 'Animation',
        '.controller': 'Animator Controller',
        '.asset': 'ScriptableObject',
        '.png': 'Texture',
        '.jpg': 'Texture',
        '.jpeg': 'Texture',
        '.tga': 'Texture',
        '.wav': 'Audio',
        '.mp3': 'Audio',
        '.ogg': 'Audio',
        '.shader': 'Shader',
        '.compute': 'Compute Shader',
        '.ttf': 'Font',
        '.otf': 'Font',
        '.physicMaterial': 'Physics Material',
        '.mask': 'Avatar Mask',
        '.playable': 'Playable',
        '.mixer': 'Audio Mixer',
        '.renderTexture': 'Render Texture',
        '.lighting': 'Lighting Settings',
        '.shadervariants': 'Shader Variants',
        '.spriteatlas': 'Sprite Atlas',
        '.guiskin': 'GUI Skin',
        '.flare': 'Flare',
        '.brush': 'Brush',
        '.overrideController': 'Animator Override Controller',
        '.preset': 'Preset',
        '.terrainlayer': 'Terrain Layer',
        '.signal': 'Signal',
        '.signalasset': 'Signal Asset',
        '.giparams': 'Global Illumination Parameters',
        '.cubemap': 'Cubemap',
    };
    return assetTypes[ext] || 'Other';
}
/**
 * Processes filesystem tool commands by validating input arguments, normalizing file paths,
 * and executing the corresponding filesystem operation.
 *
 * This asynchronous function supports various commands such as reading files, writing files,
 * editing file contents, listing directories, constructing directory trees, searching files,
 * retrieving file information, finding assets by type, and listing C# scripts. It validates
 * command-specific arguments using predefined schemas and ensures that file paths are confined
 * within the project directory. When a command is unrecognized or arguments are invalid, it
 * returns an error response.
 *
 * @param {string} name - Identifier of the filesystem tool command (e.g., "read_file", "write_file").
 * @param {*} args - Command-specific arguments whose structure is validated with predefined schemas.
 * @param {string} projectPath - Root directory used to resolve and validate file paths.
 * @returns {Promise<Object>} A promise that resolves to an object containing:
 *   - content: An array of objects with 'type' and 'text' properties representing the response message.
 *   - isError: (Optional) A boolean flag indicating whether an error occurred.
 */
export async function handleFilesystemTool(name, args, projectPath) {
    switch (name) {
        case "read_file": {
            const parsed = ReadFileArgsSchema.safeParse(args);
            if (!parsed.success) {
                return {
                    content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                    isError: true
                };
            }
            const validPath = await validatePath(parsed.data.path, projectPath);
            const content = await fs.readFile(validPath, "utf-8");
            return {
                content: [{ type: "text", text: content }],
            };
        }
        case "read_multiple_files": {
            const parsed = ReadMultipleFilesArgsSchema.safeParse(args);
            if (!parsed.success) {
                return {
                    content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                    isError: true
                };
            }
            const results = await Promise.all(parsed.data.paths.map(async (filePath) => {
                try {
                    const validPath = await validatePath(filePath, projectPath);
                    const content = await fs.readFile(validPath, "utf-8");
                    return `${filePath}:\n${content}\n`;
                }
                catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return `${filePath}: Error - ${errorMessage}`;
                }
            }));
            return {
                content: [{ type: "text", text: results.join("\n---\n") }],
            };
        }
        case "write_file": {
            const parsed = WriteFileArgsSchema.safeParse(args);
            if (!parsed.success) {
                return {
                    content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                    isError: true
                };
            }
            const validPath = await validatePath(parsed.data.path, projectPath);
            // Ensure directory exists
            const dirPath = path.dirname(validPath);
            await fs.mkdir(dirPath, { recursive: true });
            await fs.writeFile(validPath, parsed.data.content, "utf-8");
            return {
                content: [{ type: "text", text: `Successfully wrote to ${parsed.data.path}` }],
            };
        }
        case "edit_file": {
            const parsed = EditFileArgsSchema.safeParse(args);
            if (!parsed.success) {
                return {
                    content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                    isError: true
                };
            }
            const validPath = await validatePath(parsed.data.path, projectPath);
            const result = await applyFileEdits(validPath, parsed.data.edits, parsed.data.dryRun);
            return {
                content: [{ type: "text", text: result }],
            };
        }
        case "list_directory": {
            const parsed = ListDirectoryArgsSchema.safeParse(args);
            if (!parsed.success) {
                return {
                    content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                    isError: true
                };
            }
            const validPath = await validatePath(parsed.data.path, projectPath);
            const entries = await fs.readdir(validPath, { withFileTypes: true });
            const formatted = entries
                .map((entry) => {
                if (entry.isDirectory()) {
                    return `[DIR] ${entry.name}`;
                }
                else {
                    // For files, detect Unity asset type
                    const filePath = path.join(validPath, entry.name);
                    const assetType = getUnityAssetType(filePath);
                    return `[${assetType}] ${entry.name}`;
                }
            })
                .join("\n");
            return {
                content: [{ type: "text", text: formatted }],
            };
        }
        case "directory_tree": {
            const parsed = DirectoryTreeArgsSchema.safeParse(args);
            if (!parsed.success) {
                return {
                    content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                    isError: true
                };
            }
            const treeData = await buildDirectoryTree(parsed.data.path, projectPath, parsed.data.maxDepth);
            return {
                content: [{ type: "text", text: JSON.stringify(treeData, null, 2) }],
            };
        }
        case "search_files": {
            const parsed = SearchFilesArgsSchema.safeParse(args);
            if (!parsed.success) {
                return {
                    content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                    isError: true
                };
            }
            const validPath = await validatePath(parsed.data.path, projectPath);
            const results = await searchFiles(validPath, parsed.data.pattern, parsed.data.excludePatterns);
            return {
                content: [{
                        type: "text",
                        text: results.length > 0
                            ? `Found ${results.length} results:\n${results.join("\n")}`
                            : "No matches found"
                    }],
            };
        }
        case "get_file_info": {
            const parsed = GetFileInfoArgsSchema.safeParse(args);
            if (!parsed.success) {
                return {
                    content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                    isError: true
                };
            }
            const validPath = await validatePath(parsed.data.path, projectPath);
            const info = await getFileStats(validPath);
            // Also get Unity-specific info if it's an asset file
            const additionalInfo = {};
            if (info.isFile) {
                additionalInfo.assetType = getUnityAssetType(validPath);
            }
            const formattedInfo = Object.entries({ ...info, ...additionalInfo })
                .map(([key, value]) => `${key}: ${value}`)
                .join("\n");
            return {
                content: [{ type: "text", text: formattedInfo }],
            };
        }
        case "find_assets_by_type": {
            const parsed = FindAssetsByTypeArgsSchema.safeParse(args);
            if (!parsed.success) {
                return {
                    content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                    isError: true
                };
            }
            const validPath = await validatePath(parsed.data.searchPath, projectPath);
            const results = [];
            const targetType = parsed.data.assetType.toLowerCase();
            /**
             * Recursively searches a directory for Unity assets matching a specific type.
             *
             * This asynchronous function traverses the directory tree starting at the given directory.
             * For each file, it determines its Unity asset type using the external getUnityAssetType function.
             * If the asset type (in lowercase) matches the externally defined targetType, the file path is added to
             * the global results array.
             *
             * @param {string} dir - The directory path to search.
             *
             * @remark This function relies on external variables: targetType (a string representing the desired asset type)
             * and results (an array where matching asset paths are collected).
             */
            async function searchAssets(dir) {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await searchAssets(fullPath);
                    }
                    else {
                        const assetType = getUnityAssetType(fullPath);
                        if (assetType.toLowerCase() === targetType) {
                            results.push(fullPath);
                        }
                    }
                }
            }
            await searchAssets(validPath);
            return {
                content: [{
                        type: "text",
                        text: results.length > 0
                            ? `Found ${results.length} ${parsed.data.assetType} assets:\n${results.join("\n")}`
                            : `No ${parsed.data.assetType} assets found`
                    }],
            };
        }
        case "list_scripts": {
            const parsed = ListScriptsArgsSchema.safeParse(args);
            if (!parsed.success) {
                return {
                    content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                    isError: true
                };
            }
            const validPath = await validatePath(parsed.data.path, projectPath);
            const scripts = [];
            /**
             * Recursively finds all C# script files (.cs) within the specified directory.
             *
             * This asynchronous function traverses the given directory and its subdirectories.
             * When it encounters a file with a ".cs" extension, it appends an object containing
             * the file's full path and name to the global `scripts` array.
             *
             * @param {string} dir - The directory path to begin the search.
             *
             * @throws {Error} If reading the directory fails.
             */
            async function findScripts(dir) {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await findScripts(fullPath);
                    }
                    else if (path.extname(entry.name).toLowerCase() === '.cs') {
                        scripts.push({
                            path: fullPath,
                            name: entry.name
                        });
                    }
                }
            }
            await findScripts(validPath);
            const formattedScripts = scripts.map(s => `${s.name} (${s.path})`).join("\n");
            return {
                content: [{
                        type: "text",
                        text: scripts.length > 0
                            ? `Found ${scripts.length} C# scripts:\n${formattedScripts}`
                            : "No C# scripts found"
                    }],
            };
        }
        default:
            return {
                content: [{ type: "text", text: `Unknown tool: ${name}` }],
                isError: true,
            };
    }
}
// Register filesystem tools with the MCP server
// This function is now only a stub that doesn't actually do anything
/**
 * Deprecated function for registering filesystem tools.
 *
 * This function now only logs a message indicating that filesystem tool registration has moved to toolDefinitions.ts.
 *
 * @deprecated Filesystem tools registration is now performed in toolDefinitions.ts.
 */
export function registerFilesystemTools(server, wsHandler) {
    // This function is now deprecated as tool registration has moved to toolDefinitions.ts
    console.log("Filesystem tools are now registered in toolDefinitions.ts");
}
