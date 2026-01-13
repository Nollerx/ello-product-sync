import { type LoaderFunctionArgs } from "@react-router/node";
import fs from "fs";
import path from "path";

export async function loader({ request }: LoaderFunctionArgs) {
    // Determine the file path
    // In production (Docker), the build is in /app/build, and public assets are in /app/build/client
    // In development, we might need to look in public/ or dist/

    let filePath = path.join(process.cwd(), "build/client/widget-template.html");

    // Fallback for local development if build/client doesn't exist yet or is different
    if (!fs.existsSync(filePath)) {
        filePath = path.join(process.cwd(), "public/widget-template.html");
    }

    try {
        const fileContent = fs.readFileSync(filePath, "utf-8");

        return new Response(fileContent, {
            status: 200,
            headers: {
                "Content-Type": "text/html",
                "Access-Control-Allow-Origin": "*", // CRITICAL: Allow CORS requests
                "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                "Cache-Control": "public, max-age=3600"
            },
        });
    } catch (error) {
        console.error("Error serving widget.html:", error);
        return new Response("Widget template not found", { status: 404 });
    }
}
