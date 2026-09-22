import { getAuthServerUrl, getRealm, getResource, getVendorId, initTcData } from "./tidecloakConfig";
import { Models } from "@tideorg/js";
const Policy = Models.Policy;
type Policy = InstanceType<typeof Policy>;
import { base64ToBytes } from "./tideSerialization";

const getTcUrl = () => `${getAuthServerUrl()}/admin/realms/${getRealm()}`;
const getNonAdminTcUrl = () => `${getAuthServerUrl()}/realms/${getRealm()}`;

export interface ChangeSetRequest {
    changeSetId: string;
    changeSetType: string;
    actionType: string;
}

// Reads the signed admin policy snapshot written by init/tcinit.sh.
// Server-side only: this module is also bundled for the browser, so fs is
// required lazily here rather than imported at the top.
export const getAdminPolicy = async (): Promise<Policy> => {
    if (typeof window !== "undefined") {
        throw new Error("getAdminPolicy is server-side only");
    }
    const fs = require("fs");
    const path = require("path");
    const filePath = path.join(process.cwd(), "data", "admin-policy.b64");
    let b64: string;
    try {
        b64 = fs.readFileSync(filePath, "utf-8").trim();
    } catch {
        throw new Error(`Admin policy snapshot not found at ${filePath}. Run "npm run init" (or re-run the export after adding admins).`);
    }
    return Policy.from(base64ToBytes(b64));
};

export const getVendorIdForPolicy = (): string => {
    return getVendorId();
};

export const getResourceForPolicy = (): string => {
    return getResource();
};

export const getUserChangeRequests = async (token: string): Promise<{ data: any, retrievalInfo: ChangeSetRequest }[]> => {
    const response = await fetch(`${getTcUrl()}/tide-admin/change-set/users/requests`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
        throw new Error(`Error getting user change requests: ${await response.text()}`);
    }
    const json = await response.json();
    return json.map((d: any) => ({
        data: d,
        retrievalInfo: {
            changeSetId: d.draftRecordId,
            changeSetType: d.changeSetType,
            actionType: d.actionType
        }
    }));
};

export const getClientChangeRequests = async (token: string): Promise<{ data: any, retrievalInfo: ChangeSetRequest }[]> => {
    const response = await fetch(`${getTcUrl()}/tide-admin/change-set/clients/requests`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
        throw new Error(`Error getting client change requests: ${await response.text()}`);
    }
    const json = await response.json();
    return json.map((d: any) => ({
        data: d,
        retrievalInfo: {
            changeSetId: d.draftRecordId,
            changeSetType: d.changeSetType,
            actionType: d.actionType
        }
    }));
};

export const getRawChangeSetRequest = async (changeSet: ChangeSetRequest, token: string): Promise<Uint8Array> => {
    const response = await fetch(`${getTcUrl()}/tide-admin/change-set/sign/batch`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ changeSets: [changeSet] })
    });
    if (!response.ok) {
        throw new Error(`Error getting raw change set: ${await response.text()}`);
    }
    const r = (await response.json())[0];
    const binaryString = atob(r.changeSetDraftRequests);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
};

export const addApproval = async (changeSet: ChangeSetRequest, approvedRequest: Uint8Array, token: string): Promise<void> => {
    const formData = new FormData();
    formData.append("changeSetId", changeSet.changeSetId);
    formData.append("actionType", changeSet.actionType);
    formData.append("changeSetType", changeSet.changeSetType);
    const base64 = btoa(String.fromCharCode(...approvedRequest));
    formData.append("requests", base64);

    const response = await fetch(`${getTcUrl()}/tideAdminResources/add-review`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData
    });
    if (!response.ok) {
        throw new Error(`Error adding approval: ${await response.text()}`);
    }
};

export const commitChangeRequest = async (changeSet: ChangeSetRequest, token: string): Promise<void> => {
    const response = await fetch(`${getTcUrl()}/tide-admin/change-set/commit`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(changeSet)
    });
    if (!response.ok) {
        throw new Error(`Error committing change set: ${await response.text()}`);
    }
};
