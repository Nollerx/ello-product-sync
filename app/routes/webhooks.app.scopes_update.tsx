import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
// import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
    const { payload, session, topic, shop } = await authenticate.webhook(request);
    console.log(`Received ${topic} webhook for ${shop}`);

    const current = payload.current as string[];

    // With SQLiteSessionStorage, we don't manually update sessions in the DB like Prisma.
    // The library handles session persistence. 
    // If you need custom logic here, use the sessionStorage from shopify.server.ts
    if (session) {
        console.log("Scopes updated to:", current);
    }
    return new Response();
};
