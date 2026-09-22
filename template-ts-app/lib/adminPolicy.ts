// Server only. Reads the signed admin policy snapshot written by init/tcinit.sh.
// Do not import this from client components; it pulls in fs.
import fs from "fs";
import path from "path";
import { Models } from "@tideorg/js";
import { base64ToBytes } from "./tideSerialization";

const Policy = Models.Policy;
type Policy = InstanceType<typeof Policy>;

export const getAdminPolicy = async (): Promise<Policy> => {
    const filePath = path.join(process.cwd(), "data", "admin-policy.b64");
    let b64: string;
    try {
        b64 = fs.readFileSync(filePath, "utf-8").trim();
    } catch {
        console.error(`Admin policy snapshot not found at ${filePath}`);
        throw new Error(`Admin policy snapshot not found (data/admin-policy.b64). Run "npm run init", or "EXPORT_ONLY=1 bash init/tcinit.sh" to refresh it.`);
    }
    return Policy.from(base64ToBytes(b64));
};
