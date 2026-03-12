import { NextRequest, NextResponse } from "next/server";
import {
    GetAllPendingPolicies,
    CreatePolicyRequest,
    AddPolicyRequestDecision,
    CommitPolicyRequest,
    GetAllCommittedPolicies,
    ClearAllPolicies,
} from "@/lib/database/policyDb";
import { bytesToBase64 } from "@/lib/tideSerialization";

export async function GET(req: NextRequest) {
    try {
        const type = req.nextUrl.searchParams.get("type");

        if (type === "committed") {
            const policies = await GetAllCommittedPolicies();
            const serialized = policies.map(p => ({
                data: bytesToBase64(p.toBytes()),
                role: p.params.entries.get("role"),
                threshold: p.params.entries.get("threshold"),
                resource: p.params.entries.get("resource")
            }));
            return NextResponse.json(serialized);
        }

        const policies = await GetAllPendingPolicies();
        return NextResponse.json(policies);
    } catch (ex) {
        console.error("Error getting policies:", ex);
        return NextResponse.json({ error: "Internal Server Error: " + ex }, { status: 500 });
    }
}

export async function DELETE() {
    try {
        ClearAllPolicies();
        return NextResponse.json({ message: "All policies cleared" });
    } catch (ex) {
        console.error("Error clearing policies:", ex);
        return NextResponse.json({ error: "Internal Server Error: " + ex }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const { policyRequest, decision, committed, requestedBy, userVuid } = await req.json();

        if (committed) {
            const { base64ToBytes } = await import("@/lib/tideSerialization");
            await CommitPolicyRequest(committed.id, base64ToBytes(committed.signature));
        } else if (decision) {
            await AddPolicyRequestDecision(policyRequest, userVuid, decision.rejected);
        } else {
            await CreatePolicyRequest(policyRequest, requestedBy || "unknown");
        }

        return NextResponse.json({ message: "success" });
    } catch (err) {
        console.error("Error in policy POST:", err);
        return NextResponse.json({ error: "Internal Server Error: " + err }, { status: 500 });
    }
}
