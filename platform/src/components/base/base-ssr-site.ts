import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { Output, all, output } from "@pulumi/pulumi";
import { Prettify } from "../component";
import { Input } from "../input";
import { Link } from "../link.js";
import { VisibleError } from "../error.js";
import { BaseSiteFileOptions, limiter } from "./base-site";

export interface BaseSsrSiteArgs {
  assets?: Input<{
    /**
     * Character encoding for text based assets, like HTML, CSS, JS. This is
     * used to set the `Content-Type` header when these files are served out.
     *
     * If set to `"none"`, then no charset will be returned in header.
     * @default `"utf-8"`
     * @example
     * ```js
     * {
     *   assets: {
     *     textEncoding: "iso-8859-1"
     *   }
     * }
     * ```
     */
    textEncoding?: Input<
      "utf-8" | "iso-8859-1" | "windows-1252" | "ascii" | "none"
    >;
    /**
     * The `Cache-Control` header used for versioned files, like `main-1234.css`. This is
     * used by both CloudFront and the browser cache.
     *
     * The default `max-age` is set to 1 year.
     * @default `"public,max-age=31536000,immutable"`
     * @example
     * ```js
     * {
     *   assets: {
     *     versionedFilesCacheHeader: "public,max-age=31536000,immutable"
     *   }
     * }
     * ```
     */
    versionedFilesCacheHeader?: Input<string>;
    /**
     * The `Cache-Control` header used for non-versioned files, like `index.html`. This is used by both CloudFront and the browser cache.
     *
     * The default is set to not cache on browsers, and cache for 1 day on CloudFront.
     * @default `"public,max-age=0,s-maxage=86400,stale-while-revalidate=8640"`
     * @example
     * ```js
     * {
     *   assets: {
     *     nonVersionedFilesCacheHeader: "public,max-age=0,no-cache"
     *   }
     * }
     * ```
     */
    nonVersionedFilesCacheHeader?: Input<string>;
    /**
     * Specify the `Content-Type` and `Cache-Control` headers for specific files. This allows
     * you to override the default behavior for specific files using glob patterns.
     *
     * @example
     * Apply `Cache-Control` and `Content-Type` to all zip files.
     * ```js
     * {
     *   assets: {
     *     fileOptions: [
     *       {
     *         files: "**\/*.zip",
     *         contentType: "application/zip",
     *         cacheControl: "private,no-cache,no-store,must-revalidate"
     *       }
     *     ]
     *   }
     * }
     * ```
     * Apply `Cache-Control` to all CSS and JS files except for CSS files with `index-`
     * prefix in the `main/` directory.
     * ```js
     * {
     *   assets: {
     *     fileOptions: [
     *       {
     *         files: ["**\/*.css", "**\/*.js"],
     *         ignore: "main\/index-*.css",
     *         cacheControl: "private,no-cache,no-store,must-revalidate"
     *       }
     *     ]
     *   }
     * }
     * ```
     */
    fileOptions?: Input<Prettify<BaseSiteFileOptions>[]>;
  }>;
  buildCommand?: Input<string>;
  environment?: Input<Record<string, Input<string>>>;
  link?: Input<any[]>;
  path?: Input<string>;
}

export function buildApp(
  name: string,
  args: BaseSsrSiteArgs,
  sitePath: Output<string>,
  buildCommand?: Output<string>,
) {
  return all([
    sitePath,
    buildCommand ?? args.buildCommand,
    args.link,
    args.environment,
  ]).apply(([sitePath, userCommand, links, environment]) => {
    if (process.env.SKIP) return output(sitePath);
    if ($dev) return output(sitePath);

    const cmd = resolveBuildCommand();
    return runBuild();

    function resolveBuildCommand() {
      if (userCommand) return userCommand;

      // Ensure that the site has a build script defined
      if (!userCommand) {
        if (!fs.existsSync(path.join(sitePath, "package.json"))) {
          throw new VisibleError(`No package.json found at "${sitePath}".`);
        }
        const packageJson = JSON.parse(
          fs.readFileSync(path.join(sitePath, "package.json")).toString(),
        );
        if (!packageJson.scripts || !packageJson.scripts.build) {
          throw new VisibleError(
            `No "build" script found within package.json in "${sitePath}".`,
          );
        }
      }

      if (
        fs.existsSync(path.join(sitePath, "yarn.lock")) ||
        fs.existsSync(path.join($cli.paths.root, "yarn.lock"))
      )
        return "yarn run build";
      if (
        fs.existsSync(path.join(sitePath, "pnpm-lock.yaml")) ||
        fs.existsSync(path.join($cli.paths.root, "pnpm-lock.yaml"))
      )
        return "pnpm run build";
      if (
        fs.existsSync(path.join(sitePath, "bun.lockb")) ||
        fs.existsSync(path.join($cli.paths.root, "bun.lockb"))
      )
        return "bun run build";

      return "npm run build";
    }

    function runBuild() {
      // Build link environment variables to inject
      const linkData = Link.build(links || []);
      const linkEnvs = output(linkData).apply((linkData) => {
        const envs: Record<string, string> = {
          SST_RESOURCE_App: JSON.stringify({
            name: $app.name,
            stage: $app.stage,
          }),
        };
        for (const datum of linkData) {
          envs[`SST_RESOURCE_${datum.name}`] = JSON.stringify(datum.properties);
        }
        return envs;
      });

      // Run build
      return linkEnvs.apply(async (linkEnvs) => {
        try {
          await limiter.acquire("build for " + name);
          console.debug(`running "${cmd}" script for ${name}`);
          execSync(cmd, {
            cwd: sitePath,
            stdio: "inherit",
            env: {
              ...process.env,
              SST: "1",
              AWS_ACCESS_KEY_ID: process.env.SST_AWS_ACCESS_KEY_ID,
              AWS_SESSION_TOKEN: process.env.SST_AWS_SESSION_TOKEN,
              AWS_SECRET_ACCESS_KEY: process.env.SST_AWS_SECRET_ACCESS_KEY,
              AWS_REGION: process.env.SST_AWS_REGION,
              ...environment,
              ...linkEnvs,
            },
          });
        } catch (e) {
          throw new VisibleError(`There was a problem building "${name}".`);
        } finally {
          limiter.release();
        }

        return sitePath;
      });
    }
  });
}
export function getContentType(filename: string, textEncoding: string) {
  const ext = filename.endsWith(".well-known/site-association-json")
    ? ".json"
    : path.extname(filename);
  const extensions = {
    [".txt"]: { mime: "text/plain", isText: true },
    [".htm"]: { mime: "text/html", isText: true },
    [".html"]: { mime: "text/html", isText: true },
    [".xhtml"]: { mime: "application/xhtml+xml", isText: true },
    [".css"]: { mime: "text/css", isText: true },
    [".js"]: { mime: "text/javascript", isText: true },
    [".mjs"]: { mime: "text/javascript", isText: true },
    [".apng"]: { mime: "image/apng", isText: false },
    [".avif"]: { mime: "image/avif", isText: false },
    [".gif"]: { mime: "image/gif", isText: false },
    [".jpeg"]: { mime: "image/jpeg", isText: false },
    [".jpg"]: { mime: "image/jpeg", isText: false },
    [".png"]: { mime: "image/png", isText: false },
    [".svg"]: { mime: "image/svg+xml", isText: true },
    [".bmp"]: { mime: "image/bmp", isText: false },
    [".tiff"]: { mime: "image/tiff", isText: false },
    [".webp"]: { mime: "image/webp", isText: false },
    [".ico"]: { mime: "image/vnd.microsoft.icon", isText: false },
    [".eot"]: { mime: "application/vnd.ms-fontobject", isText: false },
    [".ttf"]: { mime: "font/ttf", isText: false },
    [".otf"]: { mime: "font/otf", isText: false },
    [".woff"]: { mime: "font/woff", isText: false },
    [".woff2"]: { mime: "font/woff2", isText: false },
    [".json"]: { mime: "application/json", isText: true },
    [".jsonld"]: { mime: "application/ld+json", isText: true },
    [".xml"]: { mime: "application/xml", isText: true },
    [".pdf"]: { mime: "application/pdf", isText: false },
    [".zip"]: { mime: "application/zip", isText: false },
    [".wasm"]: { mime: "application/wasm", isText: false },
    [".webmanifest"]: { mime: "application/manifest+json", isText: true },
  };
  const extensionData = extensions[ext as keyof typeof extensions];
  const mime = extensionData?.mime ?? "application/octet-stream";
  const charset =
    extensionData?.isText && textEncoding !== "none"
      ? `;charset=${textEncoding}`
      : "";
  return `${mime}${charset}`;
}
