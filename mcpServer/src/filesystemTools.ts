import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebSocketHandler } from './websocketHandler.js';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { createTwoFilesPatch } from 'diff';
import { minimatch } from 'minimatch';
import {
  ReadFileArgsSchema,
  ReadMultipleFilesArgsSchema,
  WriteFileArgsSchema,
  EditFileArgsSchema,
  ListDirectoryArgsSchema,
  DirectoryTreeArgsSchema,
  SearchFilesArgsSchema,
  GetFileInfoArgsSchema,
  FindAssetsByTypeArgsSchema,
  ListScriptsArgsSchema
} from './toolDefinitions.js';

// Interface definitions
interface FileInfo {
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  isDirectory: boolean;
  isFile: boolean;
  permissions: string;
}

interface TreeEntry {
  name: string;
  type: 'file' | 'directory';
  children?: TreeEntry[];
}

// Helper functions
/**
 * Validates and normalizes a filesystem path to ensure it resides within the specified asset root.
 *
 * This function cleans the input by stripping extraneous quotes and escape characters, defaults empty
 * or improperly formatted paths to the asset root, and resolves relative or absolute paths to a canonical form.
 * If an absolute path is provided that initially falls outside the asset root but is accessible when treated
 * as relative, the relative path is used instead. If the final resolved path escapes the asset root, an error is thrown.
 *
 * @param requestedPath - The input path to validate, which may be empty, quoted, or malformed.
 * @param assetRootPath - The base directory representing the Unity project assets.
 * @returns A Promise that resolves to the absolute, normalized path within the asset root.
 * @throws {Error} If the resolved path is outside the asset root directory.
 */
async function validatePath(requestedPath: string, assetRootPath: string): Promise<string> {
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
      } catch {
        // If we can't access it as a relative path either, keep the original absolute path
        // and let the next check handle the potential error
      }
    }
  } else {
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
 * Retrieves metadata for a given file.
 *
 * This asynchronous function obtains file statistics from the filesystem and returns details such as 
 * file size, creation, modification, and access times, as well as indicators for whether the path 
 * represents a file or directory. The file permissions are formatted as a three-digit octal string.
 *
 * @param filePath - The path to the file.
 * @returns An object containing metadata about the file.
 */
async function getFileStats(filePath: string): Promise<FileInfo> {
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
 * Recursively searches for files in the given workspace that include the specified substring in their name.
 *
 * The search starts at the provided root directory and descends into subdirectories. Files whose names contain the
 * given pattern (case-insensitive) are added to the result list. Paths that match any of the provided exclude glob
 * patterns are skipped during the search. If an exclude pattern does not include a wildcard, it is automatically
 * converted to cover nested directory structures.
 *
 * @param rootPath - The base directory to begin the search.
 * @param pattern - The substring to match within file names (case-insensitive).
 * @param excludePatterns - Optional array of glob patterns for paths to exclude from the search.
 * @returns A promise resolving to an array of file paths that match the specified criteria.
 */
async function searchFiles(
  rootPath: string,
  pattern: string,
  excludePatterns: string[] = []
): Promise<string[]> {
  const results: string[] = [];

  async function search(currentPath: string) {
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
      } catch (error) {
        // Skip invalid paths during search
        continue;
      }
    }
  }

  await search(rootPath);
  return results;
}

/**
 * Normalizes line endings in the provided text by converting Windows-style CRLF sequences to Unix-style LF.
 *
 * @param text The input text that may contain CRLF line endings.
 * @returns The text with all CRLF sequences replaced by LF.
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * Generates a unified diff string by comparing the original and modified content of a file.
 *
 * The function normalizes the line endings of both inputs to Unix-style before generating the diff,
 * ensuring a consistent and portable diff output. The file path is used in the diff header.
 *
 * @param originalContent - The original content of the file.
 * @param newContent - The modified content of the file.
 * @param filepath - The file path used in the diff header. Defaults to "file".
 * @returns The unified diff string representing the differences between the original and modified content.
 */
function createUnifiedDiff(originalContent: string, newContent: string, filepath: string = 'file'): string {
  // Ensure consistent line endings for diff
  const normalizedOriginal = normalizeLineEndings(originalContent);
  const normalizedNew = normalizeLineEndings(newContent);

  return createTwoFilesPatch(
    filepath,
    filepath,
    normalizedOriginal,
    normalizedNew,
    'original',
    'modified'
  );
}

/**
 * Applies a series of text edits to a file and returns a unified diff of the modifications.
 *
 * The function reads the file at the specified path, normalizes its line endings to Unix-style, and then applies each edit sequentially.
 * For each edit, it first attempts an exact substring replacement of the old text with the new text.
 * If an exact match is not found, it performs a line-by-line, whitespace-tolerant search to locate and replace the target content,
 * preserving the original indentation. If no matching text is found for an edit, the function throws an error.
 *
 * After processing all edits, a unified diff is generated to highlight the changes between the original and modified content.
 * The diff output is formatted with a dynamic number of backticks to prevent markdown formatting conflicts.
 *
 * If the dryRun flag is false, the modified content is saved back to the file.
 *
 * @param filePath - The path of the file to be edited.
 * @param edits - An array of edit operations, each containing an `oldText` to be replaced and the corresponding `newText`.
 * @param dryRun - When true, applies the edits only in memory and returns the diff without writing changes to the file.
 * @returns A unified diff string representing the changes made to the file.
 *
 * @throws {Error} If an edit's oldText cannot be found in the file content.
 */
async function applyFileEdits(
  filePath: string,
  edits: Array<{oldText: string, newText: string}>,
  dryRun = false
): Promise<string> {
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
          if (j === 0) return originalIndent + line.trimStart();
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
 * Recursively constructs a tree representation of a directory structure.
 *
 * The function validates and reads the specified directory, then recursively builds an array of entries representing
 * files and directories. For directories, it includes their children up to a defined maximum depth. Once the maximum
 * depth is reached, a placeholder entry with the name "..." is returned to indicate that additional contents exist.
 *
 * @param currentPath - The starting directory path from which to build the tree.
 * @param assetRootPath - The root directory used to validate that paths do not escape the intended asset scope.
 * @param maxDepth - The maximum depth for recursive traversal (default is 5).
 * @param currentDepth - The current recursion depth (default is 0, intended for internal use).
 * @returns A promise that resolves to an array of tree entries representing the directory structure.
 *
 * @throws {Error} If the provided path is invalid or if reading the directory fails.
 */
async function buildDirectoryTree(currentPath: string, assetRootPath: string, maxDepth: number = 5, currentDepth: number = 0): Promise<TreeEntry[]> {
  if (currentDepth >= maxDepth) {
    return [{ name: "...", type: "directory" }];
  }
  
  const validPath = await validatePath(currentPath, assetRootPath);
  const entries = await fs.readdir(validPath, { withFileTypes: true });
  const result: TreeEntry[] = [];

  for (const entry of entries) {
    const entryData: TreeEntry = {
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
 * This function extracts the file extension from the provided file path, normalizes it to lowercase,
 * and matches it against a set of predefined Unity asset types. If no match is found, it returns "Other".
 *
 * @param filePath - The path of the file to evaluate.
 * @returns The Unity asset type corresponding to the file extension, or "Other" if unrecognized.
 */
function getUnityAssetType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  
  // Common Unity asset types
  const assetTypes: Record<string, string> = {
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
 * Processes a filesystem tool command based on the provided command name and arguments.
 *
 * This function acts as a dispatcher for various filesystem operations in a Unity project context. It validates input arguments with defined schemas and resolves file paths relative to the project directory to ensure secure access. Supported operations include reading files (single or multiple), writing files (with directory creation), editing file content (with diff generation), listing directory contents (with Unity asset type detection), building directory trees, searching files with exclusion patterns, retrieving file information, finding assets by type, and listing C# scripts.
 *
 * @param name - The command name indicating which filesystem operation to perform.
 * @param args - The command-specific arguments expected to conform to a corresponding schema.
 * @param projectPath - The root directory of the project used to validate and resolve file paths.
 *
 * @returns An object containing a `content` array with the result messages and an optional `isError` flag when an error occurs.
 *
 * @remarks Invalid arguments are handled gracefully by returning a structured error message rather than throwing an exception.
 */
export async function handleFilesystemTool(name: string, args: any, projectPath: string) {
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
      
      const results = await Promise.all(
        parsed.data.paths.map(async (filePath: string) => {
          try {
            const validPath = await validatePath(filePath, projectPath);
            const content = await fs.readFile(validPath, "utf-8");
            return `${filePath}:\n${content}\n`;
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return `${filePath}: Error - ${errorMessage}`;
          }
        }),
      );
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
          } else {
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
      const additionalInfo: Record<string, string> = {};
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
      
      const results: string[] = [];
      const targetType = parsed.data.assetType.toLowerCase();
      
      /**
       * Recursively searches a directory for assets matching a specific Unity asset type.
       *
       * This asynchronous helper iterates over all entries in the given directory. It recurses into subdirectories and checks each file's Unity asset type using `getUnityAssetType`. If the file's asset type (after converting to lowercase) equals the target type defined in the outer scope, the file's path is added to an external `results` array.
       *
       * @param dir - The directory path to search.
       *
       * @remarks
       * The `targetType` and `results` variables must be defined in the enclosing scope.
       */
      async function searchAssets(dir: string) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          
          if (entry.isDirectory()) {
            await searchAssets(fullPath);
          } else {
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
      
      const scripts: Array<{path: string, name: string}> = [];
      
      /**
       * Recursively finds and collects C# script files within the given directory.
       *
       * This function searches the specified directory and all its subdirectories for files
       * with a ".cs" extension (case-insensitive). Each discovered C# script file is added to
       * a global array with its full path and filename.
       *
       * @param dir - The directory path from which to start the search.
       */
      async function findScripts(dir: string) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          
          if (entry.isDirectory()) {
            await findScripts(fullPath);
          } else if (path.extname(entry.name).toLowerCase() === '.cs') {
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
 * Stub function for registering filesystem tools.
 *
 * This function is deprecated and only logs that tool registration has moved to toolDefinitions.ts.
 *
 * @deprecated Tool registration has been moved to toolDefinitions.ts.
 */
export function registerFilesystemTools(server: Server, wsHandler: WebSocketHandler) {
  // This function is now deprecated as tool registration has moved to toolDefinitions.ts
  console.log("Filesystem tools are now registered in toolDefinitions.ts");
}
