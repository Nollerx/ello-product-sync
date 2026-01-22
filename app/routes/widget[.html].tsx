import { type LoaderFunctionArgs } from "react-router";
import fs from "fs";
import path from "path";

export async function loader({ request }: LoaderFunctionArgs) {
    // Determine the file path
    // In production (Docker), the build is in /app/build, and public assets are in /app/build/client
    // In development, we might need to look in public/ or dist/

    // 1. Prioritize public/ in development, build/client/ in production
    let filePath = path.join(process.cwd(), "public/widget-template.html");

    // Fallback to build/client if public doesn't exist (e.g. in some production setups)
    if (!fs.existsSync(filePath)) {
        filePath = path.join(process.cwd(), "build/client/widget-template.html");
    }

    try {
        const fileContent = fs.readFileSync(filePath, "utf-8");
        const isDev = process.env.NODE_ENV === "development";

        return new Response(fileContent, {
            status: 200,
            headers: {
                "Content-Type": "text/html",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                "Cache-Control": isDev ? "no-store, no-cache, must-revalidate" : "public, max-age=3600"
            },
        });
    } catch (error) {
        console.error("Error serving widget.html:", error);
        return new Response("Widget template not found", { status: 404 });
    }
}
