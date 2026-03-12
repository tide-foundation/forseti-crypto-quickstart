"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import hljs from 'highlight.js/lib/core';
import csharp from 'highlight.js/lib/languages/csharp';
hljs.registerLanguage('csharp', csharp);
import { IAMService } from "@tidecloak/js";
import { Models } from "@tideorg/js";
const Policy = Models.Policy;
const ExecutionType = Models.ExecutionType;
const ApprovalType = Models.ApprovalType;
import { PolicySignRequest } from "heimdall-tide";
import { useAuth } from "@/hooks/useAuth";
import {
    getVendorIdForPolicy,
} from "@/lib/tidecloakApi";
import { bytesToBase64, base64ToBytes } from "@/lib/tideSerialization";
import { contract as defaultForsetiContract, computeContractId } from "@/lib/forsetiContract";

// ─── Types ──────────────────────────────────────────────────────────────────

interface PendingPolicy {
    id: string;
    requestedBy: string;
    data: string;
    commitReady: boolean;
    approvedBy: string[];
    deniedBy: string[];
    modelId?: string;
    contractId?: string;
}

interface CommittedPolicy {
    data: string;
    role: string;
    threshold: number;
    resource: string;
}

// ─── Toggle Component ───────────────────────────────────────────────────────

function Toggle({ checked, onChange, label, children }: {
    checked: boolean;
    onChange: (v: boolean) => void;
    label: string;
    children?: React.ReactNode;
}) {
    return (
        <div className={`toggle-row${checked ? ' active' : ''}`}>
            <label className="toggle-label" onClick={() => onChange(!checked)}>
                <span className={`toggle-track${checked ? ' on' : ''}`} />
                <span className="toggle-text">{label}</span>
            </label>
            {checked && children && (
                <div className="toggle-body">{children}</div>
            )}
        </div>
    );
}

// ─── Policy Tooltip ─────────────────────────────────────────────────────────

function PolicyTooltip({ text }: { text: string }) {
    return (
        <span className="policy-tooltip-wrap">
            <span className="policy-tooltip-icon">i</span>
            <span className="policy-tooltip-bubble">{text}</span>
        </span>
    );
}

// ─── Welcome Modal ─────────────────────────────────────────────────────────

function WelcomeModal({ onClose }: { onClose: () => void }) {
    const [step, setStep] = useState(0);
    const totalSteps = 3;

    const pages = [
        {
            title: 'What is Forseti?',
            subtitle: 'The authorisation engine behind this demo',
            content: (
                <>
                    <p>
                        Forseti is an authorisation engine that executes C# smart contracts to make <strong>allow or deny</strong> decisions at the cryptographic level.
                    </p>
                    <p>
                        Every cryptographic action (encryption, decryption, signing) must provide a contract as input. Without a valid contract, the request is automatically denied.
                    </p>
                    <div className="modal-highlight">
                        <h4>How it works</h4>
                        <p>
                            Contracts run in isolation on the <strong>Tide ORK network</strong>, a decentralized set of nodes that manage cryptographic keys. Each contract is compiled from C# source via Roslyn, IL-vetted to block unsafe operations, and executed in a sandboxed process with OS-level resource limits.
                        </p>
                        <p>
                            Every ORK node independently evaluates the same contract against the same input, making the allow/deny decision <strong>deterministic and tamper-proof</strong>. No single party, not even the app developer, can bypass the rules.
                        </p>
                    </div>
                </>
            ),
        },
        {
            title: 'Validation Stages',
            subtitle: 'Three gates that control every request',
            content: (
                <>
                    <p>Contracts have three validation stages that gate different aspects of a request:</p>
                    <div className="modal-steps">
                        <div className="modal-step">
                            <span className="modal-step-num modal-step-num-sm">D</span>
                            <div>
                                <strong>ValidateData</strong>
                                <p>Always runs. Validates the request payload, e.g. &quot;is this value within allowed limits?&quot;</p>
                            </div>
                        </div>
                        <div className="modal-step">
                            <span className="modal-step-num modal-step-num-sm">A</span>
                            <div>
                                <strong>ValidateApprovers</strong>
                                <p>Runs when approval is EXPLICIT. Checks that the right people have signed off: quorum counts, distinct organisations, role requirements.</p>
                            </div>
                        </div>
                        <div className="modal-step">
                            <span className="modal-step-num modal-step-num-sm">E</span>
                            <div>
                                <strong>ValidateExecutor</strong>
                                <p>Runs when execution is PRIVATE. Verifies the identity and roles of the person triggering the action.</p>
                            </div>
                        </div>
                    </div>
                    <div className="modal-highlight" style={{ marginTop: '0.75rem' }}>
                        <p>
                            A contract&apos;s identity is the <strong>SHA-512 hash of its source code</strong>. Policy parameters (like role names or time locks) are bound at runtime via <code>[PolicyParam]</code> attributes, keeping the contract reusable across configurations.
                        </p>
                    </div>
                </>
            ),
        },
        {
            title: 'What this demo does',
            subtitle: 'Three steps to policy-enabled encryption',
            content: (
                <>
                    <p>This app walks you through the full lifecycle of a Forseti encryption policy:</p>
                    <div className="modal-steps">
                        <div className="modal-step">
                            <span className="modal-step-num">1</span>
                            <div>
                                <strong>Create a policy</strong>
                                <p>Configure a Forseti contract with parameters: role-based encryption/decryption restrictions and optional time locks.</p>
                            </div>
                        </div>
                        <div className="modal-step">
                            <span className="modal-step-num">2</span>
                            <div>
                                <strong>Approve &amp; commit</strong>
                                <p>An admin reviews and approves the policy. On commit, the ORK network compiles and stores the contract for future requests.</p>
                            </div>
                        </div>
                        <div className="modal-step">
                            <span className="modal-step-num">3</span>
                            <div>
                                <strong>Encrypt &amp; decrypt</strong>
                                <p>Every encrypt/decrypt request is evaluated by the contract on each ORK node. It checks your roles and time locks before allowing the operation.</p>
                            </div>
                        </div>
                    </div>
                </>
            ),
        },
    ];

    const page = pages[step];
    const isLast = step === totalSteps - 1;
    const isFirst = step === 0;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <p className="modal-header-label">Welcome to Forseti Crypto Quickstart</p>
                    <h2>{page.title}</h2>
                    <p className="modal-header-subtitle">{page.subtitle}</p>
                    <div className="modal-dots">
                        {pages.map((_, i) => (
                            <span key={i} className={`modal-dot${i === step ? ' active' : ''}`} onClick={() => setStep(i)} />
                        ))}
                    </div>
                </div>
                <div className="modal-body">
                    {page.content}
                </div>
                <div className="modal-footer">
                    {!isFirst && (
                        <button onClick={() => setStep(step - 1)} className="btn btn-secondary btn-lg modal-btn-back">
                            Back
                        </button>
                    )}
                    {isLast ? (
                        <button onClick={onClose} className="btn btn-primary btn-lg modal-btn-next">
                            Get Started
                        </button>
                    ) : (
                        <button onClick={() => setStep(step + 1)} className="btn btn-primary btn-lg modal-btn-next">
                            Next
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

// ─── Guide Widget ─────────────────────────────────────────────────────────

interface GuideState {
    pendingCount: number;
    hasCommitReady: boolean;
    policyLoaded: boolean;
    hasEncryptedResult: boolean;
    hasDecryptedResult: boolean;
}

function getGuideStep(state: GuideState): { step: number; title: string; message: string; tip: string } {
    const { pendingCount, hasCommitReady, policyLoaded, hasEncryptedResult, hasDecryptedResult } = state;

    if (!policyLoaded && pendingCount === 0) {
        return {
            step: 2,
            title: "Create a Policy",
            message: "Time to lay down the law! Pick your encryption rules below. Want to restrict who can encrypt? Add a role. Feeling chaotic? Leave it all open. Then smash that \"Create Forseti Policy\" button.",
            tip: "A policy is basically a bouncer for your data. It decides who gets in (encrypt) and who gets out (decrypt). No policy, no party.",
        };
    }
    if (!policyLoaded && pendingCount > 0 && !hasCommitReady) {
        return {
            step: 2,
            title: "Approve the Policy",
            message: "Your policy is sitting in the waiting room. Be a good admin and click \"Review & Approve\" to let it through!",
            tip: "We don't just let any policy waltz in here. Every rule needs an admin stamp of approval first. Trust issues? Maybe. But it keeps things secure!",
        };
    }
    if (!policyLoaded && pendingCount > 0 && hasCommitReady) {
        return {
            step: 2,
            title: "Commit to Network",
            message: "Your policy passed the vibe check! Hit \"Commit to Tide Network\" to send it out into the world.",
            tip: "Committing blasts your contract to every ORK node on the network. Think of it like publishing a new law, except way faster and with less paperwork.",
        };
    }
    if (policyLoaded && !hasEncryptedResult) {
        return {
            step: 3,
            title: "Encrypt Some Data",
            message: "Your policy is live and ready to rumble! Type in your deepest, darkest secret (or just \"hello\"), give it a tag, and click \"Encrypt\".",
            tip: "Tags are attached to your encrypted payload and get evaluated by the contract on every request. For example, the DecryptTimeLock tag tells the contract to block decryption until a specific time. Every ORK node runs your contract before letting anything through.",
        };
    }
    if (policyLoaded && hasEncryptedResult && !hasDecryptedResult) {
        return {
            step: 3,
            title: "Decrypt It Back",
            message: "Look at all that beautiful gibberish! Your encrypted data is already in the Decrypt panel. Click \"Decrypt\" to turn it back into something readable.",
            tip: "Same contract, same rules, other direction. If you set a time lock, you'll have to wait it out. No shortcuts, no cheat codes!",
        };
    }
    return {
        step: 3,
        title: "You Did It!",
        message: "Full lifecycle, done and dusted! You just created, approved, committed, encrypted, and decrypted like a pro. Hit \"Start Again\" to go another round!",
        tip: "Try cranking up the difficulty next time. Add role restrictions, set a time lock, or go full mad scientist and edit the C# contract in the sidebar!",
    };
}

function GuideWidget({ state, stepRefs, cardRef }: {
    state: GuideState;
    stepRefs: React.RefObject<(HTMLDivElement | null)[]>;
    cardRef: React.RefObject<HTMLDivElement | null>;
}) {
    const [dismissed, setDismissed] = useState(false);
    const guide = getGuideStep(state);
    const [offsetTop, setOffsetTop] = useState(0);
    const [hearts, setHearts] = useState<number[]>([]);

    const spawnHeart = () => {
        const id = Date.now();
        setHearts(prev => [...prev, id]);
        setTimeout(() => setHearts(prev => prev.filter(h => h !== id)), 900);
    };

    // Map guide step number to card step index (0=step1, 1=step2, 2=step3)
    const cardStepIndex = guide.step <= 2 ? 1 : 2;

    useEffect(() => {
        const compute = () => {
            const steps = stepRefs.current;
            const card = cardRef.current;
            if (!steps || !card) return;
            const stepEl = steps[cardStepIndex];
            if (!stepEl) return;
            const cardRect = card.getBoundingClientRect();
            const stepRect = stepEl.getBoundingClientRect();
            setOffsetTop(stepRect.top - cardRect.top);
        };
        compute();
        window.addEventListener('resize', compute);
        // Recompute on any state change with a small delay for DOM updates
        const timer = setTimeout(compute, 50);
        return () => {
            window.removeEventListener('resize', compute);
            clearTimeout(timer);
        };
    }, [cardStepIndex, state, stepRefs, cardRef]);

    if (dismissed) {
        return (
            <div className="guide-container" style={{ top: offsetTop }}>
                <div className="guide-avatar" onClick={() => { spawnHeart(); setDismissed(false); }} title="Show guide">
                    <img src="/guide-avatar.jpg" alt="Guide" className="guide-avatar-img" />
                    {hearts.map(id => <span key={id} className="guide-heart">&#10084;</span>)}
                </div>
            </div>
        );
    }

    return (
        <div className="guide-container" style={{ top: offsetTop }}>
            <div className="guide-avatar" onClick={spawnHeart}>
                <img src="/guide-avatar.jpg" alt="Guide" className="guide-avatar-img" />
                {hearts.map(id => <span key={id} className="guide-heart">&#10084;</span>)}
            </div>
            <div className="guide-bubble">
                <button className="guide-close" onClick={() => setDismissed(true)}>&times;</button>
                <div className="guide-bubble-header">
                    <span className="guide-step-badge">{guide.step}</span>
                    <span className="guide-title">{guide.title}</span>
                </div>
                <p className="guide-message">{guide.message}</p>
                <p className="guide-tip">{guide.tip}</p>
            </div>
        </div>
    );
}

// ─── Policy Preview Component ───────────────────────────────────────────────

function PolicyPreview({
    contractId,
    committed,
    encryptRole,
    decryptRole,
    contractSource,
    onContractChange,
    contractModified,
    onResetContract,
    editable,
}: {
    contractId: string;
    committed: boolean;
    encryptRole: string | null;
    decryptRole: string | null;
    contractSource: string;
    onContractChange?: (newSource: string) => void;
    contractModified?: boolean;
    onResetContract?: () => void;
    editable?: boolean;
}) {
    const [contractOpen, setContractOpen] = useState(false);
    const hasAnyParam = encryptRole !== null || decryptRole !== null;

    const editorRef = useRef<HTMLTextAreaElement>(null);
    const highlightRef = useRef<HTMLPreElement>(null);

    const highlightedContract = useMemo(() => {
        return hljs.highlight(contractSource, { language: 'csharp' }).value;
    }, [contractSource]);

    const syncScroll = useCallback(() => {
        if (editorRef.current && highlightRef.current) {
            highlightRef.current.scrollTop = editorRef.current.scrollTop;
            highlightRef.current.scrollLeft = editorRef.current.scrollLeft;
        }
    }, []);

    const handleTabKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const target = e.currentTarget;
            const start = target.selectionStart;
            const end = target.selectionEnd;
            const value = target.value;
            onContractChange?.(value.substring(0, start) + '\t' + value.substring(end));
            requestAnimationFrame(() => {
                target.selectionStart = target.selectionEnd = start + 1;
            });
        }
    };

    return (
        <div className={`policy-preview${committed ? ' policy-preview-committed' : ''}`}>
            <div className="policy-preview-header">
                <span className={`policy-preview-dot${committed ? ' committed' : ''}`} />
                {committed ? "Committed Policy" : "Policy Preview"}
            </div>
            <div className="policy-preview-body">
                <div className="policy-field">
                    <span className="policy-key">version</span>
                    <PolicyTooltip text="The policy version indicates which features it supports. All policies are backwards compatible with previous versions." />
                    <span className="policy-val policy-val-str">&quot;3&quot;</span>
                </div>
                <div className="policy-field">
                    <span className="policy-key">modelId</span>
                    <PolicyTooltip text="The Tide request models this policy is allowed to interact with. The network will reject any request whose ID is not listed here." />
                    <span className="policy-val policy-val-arr">[</span>
                </div>
                <div className="policy-field policy-field-indent">
                    <span className="policy-val policy-val-str">&quot;PolicyEnabledEncryption:1&quot;</span>
                </div>
                <div className="policy-field policy-field-indent">
                    <span className="policy-val policy-val-str">&quot;PolicyEnabledDecryption:1&quot;</span>
                </div>
                <div className="policy-field">
                    <span className="policy-val policy-val-arr">]</span>
                </div>
                <div className="policy-field">
                    <span className="policy-key">contractId</span>
                    <PolicyTooltip text="A SHA-512 hash of your contract's source code (in hex). This links the policy to a specific contract." />
                    <span className="policy-val policy-val-str policy-val-truncate" title={contractId}>
                        &quot;{contractId.substring(0, 16)}...&quot;
                    </span>
                </div>
                <div className="policy-field">
                    <span className="policy-key">executionType</span>
                    <PolicyTooltip text="Controls whether the contract checks the executor's roles and permissions. PRIVATE means the contract will enforce role checks; PUBLIC skips them." />
                    <span className="policy-val policy-val-enum">PRIVATE</span>
                </div>
                <div className="policy-field">
                    <span className="policy-key">approvalType</span>
                    <PolicyTooltip text="Controls whether the contract checks approvers' roles and permissions. IMPLICIT skips approver checks; EXPLICIT requires the contract to verify each approver." />
                    <span className="policy-val policy-val-enum">IMPLICIT</span>
                </div>

                <div className="policy-divider" />

                <div className="policy-field">
                    <span className="policy-key">params</span>
                    <PolicyTooltip text="Custom values passed to the contract, such as EncryptionRealmRole. Think of the contract as a reusable function and params as its arguments." />
                    <span className="policy-val policy-val-arr">
                        {hasAnyParam ? "{" : "{ }"}
                    </span>
                    {!hasAnyParam && (
                        <span className="policy-hint">no restrictions</span>
                    )}
                </div>

                {hasAnyParam && (
                    <>
                        {encryptRole !== null && (
                            <div className="policy-field policy-field-indent policy-field-active">
                                <span className="policy-key">EncryptionRealmRole</span>
                                {encryptRole ? (
                                    <span className="policy-val policy-val-str">&quot;{encryptRole}&quot;</span>
                                ) : (
                                    <span className="policy-val policy-val-placeholder">awaiting value...</span>
                                )}
                            </div>
                        )}
                        {decryptRole !== null && (
                            <div className="policy-field policy-field-indent policy-field-active">
                                <span className="policy-key">DecryptionRealmRole</span>
                                {decryptRole ? (
                                    <span className="policy-val policy-val-str">&quot;{decryptRole}&quot;</span>
                                ) : (
                                    <span className="policy-val policy-val-placeholder">awaiting value...</span>
                                )}
                            </div>
                        )}
                        <div className="policy-field">
                            <span className="policy-val policy-val-arr">{"}"}</span>
                        </div>
                    </>
                )}

                <div className="policy-divider" />

                <div
                    className="contract-toggle"
                    onClick={() => setContractOpen(prev => !prev)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setContractOpen(prev => !prev); }}
                >
                    <span className={`contract-chevron${contractOpen ? ' open' : ''}`}>
                        {'\u25B6'}
                    </span>
                    {contractOpen
                        ? (editable ? "Hide contract editor" : "Hide contract source")
                        : (editable ? "Edit contract source" : "View contract source")
                    }
                </div>
                {contractOpen && (
                    <div className="contract-source">
                        <div className="contract-source-header">
                            <span>
                                ForsetiContract.cs
                                {contractModified && (
                                    <span className="contract-modified-badge">modified</span>
                                )}
                            </span>
                            <span className="contract-source-header-actions">
                                <span className="contract-source-lines">
                                    {contractSource.split('\n').length} lines
                                </span>
                                {contractModified && editable && onResetContract && (
                                    <button
                                        className="contract-reset-btn"
                                        onClick={onResetContract}
                                    >
                                        Reset to default
                                    </button>
                                )}
                            </span>
                        </div>
                        {editable && contractModified && (
                            <div className="contract-warning">
                                This contract will be uploaded to the Forseti ORK network and will
                                govern encryption/decryption access control. The contract ID updates
                                automatically with every edit.
                            </div>
                        )}
                        {editable ? (
                            <div className="contract-editor-wrap">
                                <pre
                                    className="contract-source-code contract-highlight-layer"
                                    ref={highlightRef}
                                    aria-hidden="true"
                                >
                                    <code dangerouslySetInnerHTML={{ __html: highlightedContract }} />
                                    {/* trailing newline so pre height matches textarea */}
                                    {'\n'}
                                </pre>
                                <textarea
                                    className="contract-source-editor"
                                    ref={editorRef}
                                    value={contractSource}
                                    onChange={(e) => onContractChange?.(e.target.value)}
                                    onScroll={syncScroll}
                                    onKeyDown={handleTabKey}
                                    spellCheck={false}
                                    autoComplete="off"
                                    autoCorrect="off"
                                />
                            </div>
                        ) : (
                            <pre className="contract-source-code">
                                <code dangerouslySetInnerHTML={{ __html: highlightedContract }} />
                            </pre>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

export default function HomePage() {
    const {
        isAuthenticated, isLoading, vuid, userId, tokenRoles,
        refreshToken,
        initializeTideRequest, approveTideRequests, executeTideRequest,
        doEncrypt, doDecrypt,
    } = useAuth();

    // Welcome modal
    const [showWelcome, setShowWelcome] = useState(() => {
        if (typeof window !== 'undefined') {
            return !sessionStorage.getItem('forseti-welcome-dismissed');
        }
        return true;
    });

    const dismissWelcome = () => {
        setShowWelcome(false);
        sessionStorage.setItem('forseti-welcome-dismissed', '1');
    };

    // Editable contract state
    const [editedContract, setEditedContract] = useState(defaultForsetiContract);
    const [contractModified, setContractModified] = useState(false);

    // Contract ID (SHA-512 of contract source, debounced)
    const [forsetiContractId, setForsetiContractId] = useState("");
    useEffect(() => {
        const timer = setTimeout(() => {
            computeContractId(editedContract).then(setForsetiContractId);
        }, 300);
        return () => clearTimeout(timer);
    }, [editedContract]);

    // Browser detection
    const isFirefox = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent);

    // Policy state
    const [pendingPolicies, setPendingPolicies] = useState<PendingPolicy[]>([]);
    const [forsetiPolicy, setForsetiPolicy] = useState<Uint8Array | null>(null);
    const [policyLoaded, setPolicyLoaded] = useState(false);
    const [committedParams, setCommittedParams] = useState<{
        encryptRole: string | null;
        decryptRole: string | null;
    } | null>(null);

    // Policy creation toggles
    const [requireEncryptRole, setRequireEncryptRole] = useState(false);
    const [encryptRole, setEncryptRole] = useState("");
    const [requireDecryptRole, setRequireDecryptRole] = useState(false);
    const [decryptRole, setDecryptRole] = useState("");
    const [setTimeLock, setSetTimeLock] = useState(false);
    const [timeLockDate, setTimeLockDate] = useState("");

    // Tags state
    const [tags, setTags] = useState<string[]>([]);
    const [tagInput, setTagInput] = useState("");

    // Encryption state
    const [plaintext, setPlaintext] = useState("");
    const [encryptedResult, setEncryptedResult] = useState("");

    // Decryption state
    const [encryptedInput, setEncryptedInput] = useState("");
    const [decryptedResult, setDecryptedResult] = useState("");

    const [loadingAction, setLoadingAction] = useState<string | null>(null);

    const [message, setMessage] = useState("");
    const [messageType, setMessageType] = useState<"info" | "success" | "error">("info");

    const showMessage = (msg: string, type: "info" | "success" | "error" = "info") => {
        setMessage(msg);
        setMessageType(type);
    };

    // ─── Data fetching ──────────────────────────────────────────────────────

    useEffect(() => {
        if (!isLoading && !isAuthenticated) {
            window.location.href = "/";
        }
    }, [isAuthenticated, isLoading]);

    useEffect(() => {
        if (isAuthenticated) {
            refreshAllData();
        }
    }, [isAuthenticated]);

    const refreshAllData = async () => {
        await Promise.all([
            fetchPendingPolicies(),
            fetchForsetiPolicy(),
        ]);
    };

    const fetchPendingPolicies = async () => {
        try {
            const response = await fetch("/api/policies");
            if (response.ok) {
                const data = await response.json();
                const policiesWithDetails = data.map((p: any) => {
                    try {
                        const req = PolicySignRequest.decode(base64ToBytes(p.data));
                        const policy = req.getRequestedPolicy();
                        return {
                            ...p,
                            modelId: policy.modelIds[0],
                            contractId: policy.contractId
                        };
                    } catch {
                        return p;
                    }
                });
                setPendingPolicies(policiesWithDetails);
            }
        } catch (error: any) {
            console.error("Error fetching pending policies:", error);
        }
    };

    const fetchForsetiPolicy = async () => {
        try {
            const response = await fetch("/api/policies?type=committed");
            if (response.ok) {
                const policies: CommittedPolicy[] = await response.json();
                for (const p of policies) {
                    const policy = Policy.from(base64ToBytes(p.data));
                    if (policy.contractId === forsetiContractId) {
                        setForsetiPolicy(policy.toBytes());
                        setPolicyLoaded(true);
                        try {
                            const params = policy.params;
                            const encRole = params?.entries?.get("EncryptionRealmRole");
                            const decRole = params?.entries?.get("DecryptionRealmRole");
                            setCommittedParams({
                                encryptRole: encRole != null ? String(encRole) : null,
                                decryptRole: decRole != null ? String(decRole) : null,
                            });
                        } catch {
                            setCommittedParams(null);
                        }
                        return;
                    }
                }
                setPolicyLoaded(false);
            }
        } catch (error: any) {
            console.error("Error fetching Forseti policy:", error);
            setPolicyLoaded(false);
        }
    };

    // ─── Step 2: Policy Handlers ────────────────────────────────────────────

    const handleCreateForsetiPolicy = async () => {
        if (!editedContract.trim()) {
            showMessage("Contract source cannot be empty.", "error");
            return;
        }
        setLoadingAction("create");
        try {
            showMessage("Creating Forseti encryption policy...");
            const vendorId = getVendorIdForPolicy();

            const params = new Map<string, any>();
            if (requireEncryptRole && encryptRole.trim()) {
                params.set("EncryptionRealmRole", encryptRole.trim());
            }
            if (requireDecryptRole && decryptRole.trim()) {
                params.set("DecryptionRealmRole", decryptRole.trim());
            }

            const newPolicyRequest = PolicySignRequest.New(new Policy({
                version: "3",
                modelId: ["PolicyEnabledEncryption:1", "PolicyEnabledDecryption:1"],
                contractId: forsetiContractId,
                keyId: vendorId,
                executionType: ExecutionType.PRIVATE,
                approvalType: ApprovalType.IMPLICIT,
                params: params
            }));
            console.log(params);
            newPolicyRequest.setCustomExpiry(604800); // 1 week
            newPolicyRequest.addForsetiContractToUpload(editedContract);

            const initializedRequest = await initializeTideRequest(newPolicyRequest);

            const response = await fetch("/api/policies", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    policyRequest: bytesToBase64(initializedRequest.encode()),
                    requestedBy: vuid
                })
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || "Failed to create Forseti policy");
            }

            showMessage("Forseti policy created. An admin must now review and approve it.", "success");
            await fetchPendingPolicies();
        } catch (error: any) {
            showMessage(`Error creating policy: ${error.message}`, "error");
        } finally {
            setLoadingAction(null);
        }
    };

    const handleReviewPolicy = async (policy: PendingPolicy) => {
        setLoadingAction("review");
        try {
            showMessage(`Reviewing policy ${policy.id.substring(0, 8)}...`);
            const req = PolicySignRequest.decode(base64ToBytes(policy.data));

            const approvalResults = await approveTideRequests([{
                id: policy.id,
                request: req.encode()
            }]);

            const result = approvalResults[0];
            if (result.approved) {
                await fetch("/api/policies", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        policyRequest: bytesToBase64(result.approved.request),
                        decision: { rejected: false },
                        userVuid: vuid
                    })
                });
                showMessage("Policy approved.", "success");
            } else if (result.denied) {
                await fetch("/api/policies", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        policyRequest: bytesToBase64(req.encode()),
                        decision: { rejected: true },
                        userVuid: vuid
                    })
                });
                showMessage("Policy denied.", "error");
            } else {
                showMessage("Policy pending.");
            }

            await fetchPendingPolicies();
        } catch (error: any) {
            showMessage(`Error reviewing policy: ${error.message}`, "error");
        } finally {
            setLoadingAction(null);
        }
    };

    const handleCommitPolicy = async (policy: PendingPolicy) => {
        setLoadingAction("commit");
        try {
            showMessage("Committing policy...");
            const req = PolicySignRequest.decode(base64ToBytes(policy.data));
            const signatures = await executeTideRequest(req.encode(), true);
            const policySignature = signatures[0];

            const response = await fetch("/api/policies", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    committed: {
                        id: policy.id,
                        signature: bytesToBase64(policySignature)
                    }
                })
            });

            if (!response.ok) throw new Error("Failed to commit policy");
            showMessage("Policy committed! You can now encrypt and decrypt.", "success");
            await Promise.all([fetchPendingPolicies(), fetchForsetiPolicy()]);
        } catch (error: any) {
            showMessage(`Error committing policy: ${error.message}`, "error");
        } finally {
            setLoadingAction(null);
        }
    };

    // ─── Tags helpers ──────────────────────────────────────────────────────

    const addTag = (value: string) => {
        const trimmed = value.trim();
        if (trimmed && !tags.includes(trimmed)) {
            setTags([...tags, trimmed]);
        }
        setTagInput("");
    };

    const removeTag = (tag: string) => {
        setTags(tags.filter(t => t !== tag));
    };

    const getEffectiveTags = () => {
        const effective = [...tags];
        // Auto-add time lock tag if configured
        if (setTimeLock && timeLockDate) {
            const epochSeconds = Math.floor(new Date(timeLockDate).getTime() / 1000);
            const timeLockTag = `DecryptTimeLock:${epochSeconds}`;
            if (!effective.includes(timeLockTag)) {
                effective.push(timeLockTag);
            }
        }
        return effective.length > 0 ? effective : ["default"];
    };

    // ─── Step 3: Encrypt/Decrypt Handlers ───────────────────────────────────

    const handleEncrypt = async () => {
        if (!plaintext.trim()) {
            showMessage("Please enter text to encrypt.", "error");
            return;
        }
        if (!forsetiPolicy) {
            showMessage("No Forseti policy found. Complete Step 2 first.", "error");
            return;
        }
        setLoadingAction("encrypt");
        try {
            showMessage("Encrypting...");
            const results = await doEncrypt(
                [{ data: plaintext, tags: getEffectiveTags() }],
                forsetiPolicy
            );
            setEncryptedResult(results[0]);
            setEncryptedInput(results[0]);
            showMessage("Encryption successful!", "success");
        } catch (error: any) {
            showMessage(`Encryption error: ${error.message}`, "error");
        } finally {
            setLoadingAction(null);
        }
    };

    const handleDecrypt = async () => {
        if (!encryptedInput.trim()) {
            showMessage("Please enter encrypted data to decrypt.", "error");
            return;
        }
        if (!forsetiPolicy) {
            showMessage("No Forseti policy found. Complete Step 2 first.", "error");
            return;
        }
        setLoadingAction("decrypt");
        try {
            showMessage("Decrypting...");
            const results = await doDecrypt(
                [{ encrypted: encryptedInput, tags: getEffectiveTags() }],
                forsetiPolicy
            );
            setDecryptedResult(String(results[0]));
            showMessage("Decryption successful!", "success");
        } catch (error: any) {
            showMessage(`Decryption error: ${error.message}`, "error");
        } finally {
            setLoadingAction(null);
        }
    };

    const handleCopyToDecrypt = () => {
        setEncryptedInput(encryptedResult);
    };

    const handleStartAgain = async () => {
        try {
            await fetch("/api/policies", { method: "DELETE" });
        } catch (e) {
            console.error("Failed to clear policies:", e);
        }
        setForsetiPolicy(null);
        setPolicyLoaded(false);
        setCommittedParams(null);
        setPendingPolicies([]);
        setRequireEncryptRole(false);
        setEncryptRole("");
        setRequireDecryptRole(false);
        setDecryptRole("");
        setSetTimeLock(false);
        setTimeLockDate("");
        setTags([]);
        setTagInput("");
        setPlaintext("");
        setEncryptedResult("");
        setEncryptedInput("");
        setDecryptedResult("");
        setEditedContract(defaultForsetiContract);
        setContractModified(false);
        setMessage("");
        setMessageType("info");
        setLoadingAction(null);
    };

    // ─── UI Handlers ────────────────────────────────────────────────────────

    const handleLogout = () => {
        IAMService.doLogout();
    };

    const handleRefreshToken = async () => {
        try {
            await refreshToken();
            showMessage("Token refreshed.", "success");
        } catch (error: any) {
            showMessage(`Error refreshing token: ${error.message}`, "error");
        }
    };

    // Refs for guide positioning
    const cardRef = useRef<HTMLDivElement>(null);
    const stepRefs = useRef<(HTMLDivElement | null)[]>([null, null, null]);

    if (isLoading) return <div className="page-container"><p style={{ color: 'var(--text-muted)' }}>Loading...</p></div>;
    if (!isAuthenticated) return <div className="page-container"><p style={{ color: 'var(--text-muted)' }}>Redirecting...</p></div>;

    const username = IAMService.getValueFromIDToken?.("preferred_username") || vuid.substring(0, 16);

    // Resolve preview params: use committed policy params if available, otherwise derive from toggles
    const previewParams = policyLoaded && committedParams
        ? committedParams
        : {
            encryptRole: requireEncryptRole ? encryptRole.trim() || "" : null,
            decryptRole: requireDecryptRole ? decryptRole.trim() || "" : null,
        };

    const guideState: GuideState = {
        pendingCount: pendingPolicies.length,
        hasCommitReady: pendingPolicies.some(p => p.commitReady),
        policyLoaded,
        hasEncryptedResult: !!encryptedResult,
        hasDecryptedResult: !!decryptedResult,
    };

    return (
        <div className="page-container page-container-with-preview">
            {showWelcome && <WelcomeModal onClose={dismissWelcome} />}
            <GuideWidget state={guideState} stepRefs={stepRefs} cardRef={cardRef} />
            <div className="card" ref={cardRef}>
                {/* ─── Header ──────────────────────────────────────────── */}
                <div className="card-header">
                    <h1>Forseti Crypto Quickstart</h1>
                    <div className="card-header-sub">
                        <span>Signed in as <strong>{username}</strong></span>
                        <code>{vuid.substring(0, 12)}...</code>
                    </div>
                    <div className="card-header-actions">
                        <button onClick={() => setShowWelcome(true)} className="btn btn-outline btn-sm" title="About Forseti">?</button>
                        <button onClick={handleLogout} className="btn btn-outline btn-sm">Log out</button>
                        <button onClick={handleRefreshToken} className="btn btn-outline btn-sm">Refresh Token</button>
                        <button onClick={refreshAllData} className="btn btn-outline btn-sm">Refresh Data</button>
                    </div>
                </div>

                <div className="card-body">
                    {/* ─── Message Banner ──────────────────────────────── */}
                    {message && (
                        <div className={`message-banner ${messageType}`}>
                            {message}
                        </div>
                    )}

                    {/* ─── Step 1: Logged In ───────────────────────────── */}
                    <div className="step completed" ref={el => { stepRefs.current[0] = el; }}>
                        <div className="step-header">
                            <span className="step-number done">1</span>
                            <span className="step-title">Authenticated via TideCloak</span>
                        </div>
                        <p className="step-success">
                            Signed in as {username}
                        </p>
                    </div>

                    {/* ─── Step 2: Forseti Policy ──────────────────────── */}
                    <div className={`step${policyLoaded ? ' completed' : !policyLoaded && pendingPolicies.length === 0 ? ' active' : ''}`} ref={el => { stepRefs.current[1] = el; }}>
                        <div className="step-header">
                            <span className={`step-number${policyLoaded ? ' done' : ' active'}`}>2</span>
                            <span className="step-title">Forseti Encryption Policy</span>
                        </div>

                        {policyLoaded ? (
                            <>
                                <p className="step-success">Policy committed and active.</p>
                                <p className="step-detail">
                                    The Forseti smart contract is deployed on the Tide ORK network. All encrypt/decrypt operations below will be governed by this policy.
                                </p>
                            </>
                        ) : (
                            <>
                                <p className="step-description" style={{ marginBottom: '0.75rem' }}>
                                    A Forseti policy defines <strong>who</strong> can encrypt and decrypt, and <strong>when</strong>. Configure the rules below, then create the policy. It must be approved by an admin and committed to the Tide network before it takes effect.
                                </p>

                                {pendingPolicies.length === 0 && (
                                    <div>
                                        <Toggle
                                            checked={requireEncryptRole}
                                            onChange={setRequireEncryptRole}
                                            label="Require realm role to encrypt"
                                        >
                                            <input
                                                type="text"
                                                value={encryptRole}
                                                onChange={(e) => setEncryptRole(e.target.value)}
                                                placeholder="e.g. executive"
                                                className="input"
                                            />
                                            <p className={`toggle-hint${encryptRole.trim() ? ' toggle-hint-active' : ''}`}>
                                                {encryptRole.trim()
                                                    ? `Only users with the "${encryptRole.trim()}" role in TideCloak will be able to encrypt data.`
                                                    : 'Enter a TideCloak realm role name. Only users assigned this role will be allowed to encrypt.'}
                                            </p>
                                        </Toggle>

                                        <Toggle
                                            checked={requireDecryptRole}
                                            onChange={setRequireDecryptRole}
                                            label="Require realm role to decrypt"
                                        >
                                            <input
                                                type="text"
                                                value={decryptRole}
                                                onChange={(e) => setDecryptRole(e.target.value)}
                                                placeholder="e.g. factoryoperator"
                                                className="input"
                                            />
                                            <p className={`toggle-hint${decryptRole.trim() ? ' toggle-hint-active' : ''}`}>
                                                {decryptRole.trim()
                                                    ? `Only users with the "${decryptRole.trim()}" role in TideCloak will be able to decrypt data.`
                                                    : 'Enter a TideCloak realm role name. Only users assigned this role will be allowed to decrypt.'}
                                            </p>
                                        </Toggle>

                                        <Toggle
                                            checked={setTimeLock}
                                            onChange={setSetTimeLock}
                                            label="Set decryption time lock"
                                        >
                                            {isFirefox ? (
                                                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                                    <input
                                                        type="date"
                                                        value={timeLockDate.split('T')[0] || ''}
                                                        onChange={(e) => {
                                                            const time = timeLockDate.split('T')[1] || '00:00';
                                                            setTimeLockDate(e.target.value ? `${e.target.value}T${time}` : '');
                                                        }}
                                                        className="input"
                                                        style={{ flex: 2 }}
                                                    />
                                                    <select
                                                        value={timeLockDate.split('T')[1]?.split(':')[0] || '00'}
                                                        onChange={(e) => {
                                                            const date = timeLockDate.split('T')[0] || '';
                                                            const min = timeLockDate.split('T')[1]?.split(':')[1] || '00';
                                                            if (date) setTimeLockDate(`${date}T${e.target.value}:${min}`);
                                                        }}
                                                        className="input"
                                                        style={{ flex: 1 }}
                                                    >
                                                        {Array.from({ length: 24 }, (_, i) => (
                                                            <option key={i} value={String(i).padStart(2, '0')}>{String(i).padStart(2, '0')}</option>
                                                        ))}
                                                    </select>
                                                    <span style={{ color: 'var(--text-muted)', fontWeight: 700 }}>:</span>
                                                    <select
                                                        value={timeLockDate.split('T')[1]?.split(':')[1] || '00'}
                                                        onChange={(e) => {
                                                            const date = timeLockDate.split('T')[0] || '';
                                                            const hr = timeLockDate.split('T')[1]?.split(':')[0] || '00';
                                                            if (date) setTimeLockDate(`${date}T${hr}:${e.target.value}`);
                                                        }}
                                                        className="input"
                                                        style={{ flex: 1 }}
                                                    >
                                                        {Array.from({ length: 60 }, (_, i) => (
                                                            <option key={i} value={String(i).padStart(2, '0')}>{String(i).padStart(2, '0')}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                            ) : (
                                                <input
                                                    type="datetime-local"
                                                    value={timeLockDate}
                                                    onChange={(e) => setTimeLockDate(e.target.value)}
                                                    className="input"
                                                />
                                            )}
                                            <p className="toggle-hint">
                                                {timeLockDate
                                                    ? `Decryption will be blocked until ${new Date(timeLockDate).toLocaleString()}. The Tide network enforces this server-side and it cannot be bypassed client-side.`
                                                    : 'Pick a date and time. The Tide ORK network will refuse decryption requests until this moment passes.'}
                                            </p>
                                        </Toggle>

                                        <button
                                            onClick={handleCreateForsetiPolicy}
                                            disabled={!!loadingAction}
                                            className="btn btn-primary btn-lg"
                                            style={{ width: '100%', marginTop: '0.75rem' }}
                                        >
                                            {loadingAction === "create" ? "Creating..." : "Create Forseti Policy"}
                                        </button>
                                    </div>
                                )}

                                {pendingPolicies.length > 0 && (
                                    <div>
                                        <p className="step-detail" style={{ marginBottom: '0.5rem' }}>
                                            {pendingPolicies.some(p => p.commitReady)
                                                ? 'A policy has enough approvals and is ready to be committed to the Tide network.'
                                                : 'Policies below need to be reviewed and approved by an admin before they can be committed.'}
                                        </p>
                                        {pendingPolicies.map((policy) => (
                                            <div key={policy.id} className="pending-card">
                                                <div className="pending-card-meta">
                                                    Contract: {policy.contractId ? policy.contractId.substring(0, 20) + "..." : "Unknown"}
                                                </div>
                                                <div className="pending-card-status">
                                                    <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                                                        {policy.approvedBy?.length || 0} approval{(policy.approvedBy?.length || 0) !== 1 ? 's' : ''}
                                                    </span>
                                                    {policy.commitReady ? (
                                                        <span className="badge badge-ready">Ready to commit</span>
                                                    ) : (
                                                        <span className="badge badge-waiting">Awaiting approvals</span>
                                                    )}
                                                </div>
                                                <div className="pending-card-actions">
                                                    {!policy.approvedBy?.includes(vuid) && !policy.commitReady && (
                                                        <button onClick={() => handleReviewPolicy(policy)} disabled={!!loadingAction} className="btn btn-action btn-sm">
                                                            {loadingAction === "review" ? "Reviewing..." : "Review & Approve"}
                                                        </button>
                                                    )}
                                                    {policy.commitReady && (
                                                        <button onClick={() => handleCommitPolicy(policy)} disabled={!!loadingAction} className="btn btn-action btn-sm">
                                                            {loadingAction === "commit" ? "Committing..." : "Commit to Tide Network"}
                                                        </button>
                                                    )}
                                                    {policy.approvedBy?.includes(vuid) && !policy.commitReady && (
                                                        <span style={{ fontSize: '0.8rem', color: 'var(--success)' }}>You approved this, waiting for more approvals</span>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </>
                        )}
                    </div>

                    {/* ─── Step 3: Encrypt & Decrypt ───────────────────── */}
                    <div className={`step${policyLoaded ? ' active' : ''}`} ref={el => { stepRefs.current[2] = el; }}>
                        <div className="step-header">
                            <span className={`step-number${policyLoaded ? ' active' : ''}`}>3</span>
                            <span className="step-title">Encrypt & Decrypt</span>
                        </div>

                        {!policyLoaded ? (
                            <p className="step-description" style={{ color: 'var(--text-muted)' }}>
                                Complete Step 2 to unlock encryption and decryption. The committed policy will govern who can perform these operations.
                            </p>
                        ) : (
                            <>
                                <p className="step-description" style={{ marginBottom: '0.75rem' }}>
                                    Data is encrypted and decrypted through the Tide ORK network. Tags are attached to the encrypted payload and evaluated by the contract. The Forseti contract enforces your policy rules server-side.
                                </p>

                                {/* ── Tags Section ── */}
                                <div className="tags-section">
                                    <label className="field-label">Tag Encryption</label>
                                    <p className="tags-hint">
                                        Label your encrypted data with a tag. The contract can use tags like <code>DecryptTimeLock:&#123;epoch&#125;</code> to enforce rules at decryption time.
                                        {setTimeLock && timeLockDate && (
                                            <span className="tags-hint-auto"> A time lock tag will be auto-added from your Step 2 configuration.</span>
                                        )}
                                    </p>
                                    {(() => {
                                        const hasTimeLock = !!(setTimeLock && timeLockDate);
                                        const hasTag = tags.length > 0 || hasTimeLock;
                                        const inputDisabled = hasTag;
                                        return (
                                            <div className="tags-input-row">
                                                <input
                                                    type="text"
                                                    value={tagInput}
                                                    onChange={(e) => setTagInput(e.target.value)}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter') {
                                                            e.preventDefault();
                                                            addTag(tagInput);
                                                        }
                                                    }}
                                                    placeholder={inputDisabled ? 'Tag already set' : 'Add a tag...'}
                                                    className="input"
                                                    disabled={inputDisabled}
                                                />
                                                <button
                                                    onClick={() => addTag(tagInput)}
                                                    disabled={!tagInput.trim() || inputDisabled}
                                                    className="btn btn-outline btn-sm"
                                                >
                                                    Add
                                                </button>
                                            </div>
                                        );
                                    })()}
                                    <div className="tags-list">
                                        {getEffectiveTags().map((tag) => {
                                            const isTimeLock = tag.startsWith("DecryptTimeLock:");
                                            const isAutoTag = isTimeLock && !tags.includes(tag);
                                            let readableTime = '';
                                            if (isTimeLock) {
                                                const epoch = parseInt(tag.split(':')[1], 10);
                                                if (!isNaN(epoch)) {
                                                    readableTime = new Date(epoch * 1000).toLocaleString();
                                                }
                                            }
                                            return (
                                                <span key={tag} className="tag-wrap">
                                                    <span className={`tag${isTimeLock ? ' tag-timelock' : ''}${isAutoTag ? ' tag-auto' : ''}`}>
                                                        {tag}
                                                        {isAutoTag ? (
                                                            <span className="tag-auto-label">auto</span>
                                                        ) : (
                                                            <button className="tag-remove" onClick={() => removeTag(tag)}>&times;</button>
                                                        )}
                                                    </span>
                                                    {readableTime && <span className="tag-time-readable">{readableTime}</span>}
                                                </span>
                                            );
                                        })}
                                    </div>
                                </div>

                                <div className="crypto-grid">
                                    {/* ── Encrypt Panel ── */}
                                    <div className="crypto-panel">
                                        <h4>Encrypt</h4>
                                        <label className="field-label">Plaintext</label>
                                        <textarea
                                            value={plaintext}
                                            onChange={(e) => setPlaintext(e.target.value)}
                                            placeholder="Type or paste any text to encrypt..."
                                            rows={3}
                                            className="input input-mono"
                                        />
                                        <button
                                            onClick={handleEncrypt}
                                            disabled={loadingAction === "encrypt"}
                                            className="btn btn-primary"
                                            style={{ width: '100%', marginTop: '0.5rem' }}
                                        >
                                            {loadingAction === "encrypt" ? "Encrypting..." : "Encrypt"}
                                        </button>

                                        {encryptedResult && (
                                            <div className="result-box">
                                                <div className="result-label">Encrypted output</div>
                                                <div className="result-value">{encryptedResult}</div>
                                                <button
                                                    onClick={handleCopyToDecrypt}
                                                    className="btn btn-ghost btn-sm"
                                                    style={{ marginTop: '0.5rem', width: '100%' }}
                                                >
                                                    Copy to Decrypt Panel
                                                </button>
                                            </div>
                                        )}
                                    </div>

                                    {/* ── Decrypt Panel ── */}
                                    <div className="crypto-panel">
                                        <h4>Decrypt</h4>
                                        <label className="field-label">Ciphertext</label>
                                        <textarea
                                            value={encryptedInput}
                                            onChange={(e) => setEncryptedInput(e.target.value)}
                                            placeholder="Paste encrypted output here..."
                                            rows={3}
                                            className="input input-mono"
                                        />
                                        <button
                                            onClick={handleDecrypt}
                                            disabled={loadingAction === "decrypt"}
                                            className="btn btn-primary"
                                            style={{ width: '100%', marginTop: '0.5rem' }}
                                        >
                                            {loadingAction === "decrypt" ? "Decrypting..." : "Decrypt"}
                                        </button>

                                        {decryptedResult && (
                                            <div className="result-box">
                                                <div className="result-label">Decrypted output</div>
                                                <div className="result-value">{decryptedResult}</div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </>
                        )}
                    </div>

                    {/* ─── Start Again ─────────────────────────────────── */}
                    <div className="start-again-section">
                        <button onClick={handleStartAgain} className="btn btn-muted">
                            Start Again
                        </button>
                    </div>
                </div>
            </div>

            <PolicyPreview
                contractId={forsetiContractId}
                committed={policyLoaded}
                encryptRole={previewParams.encryptRole}
                decryptRole={previewParams.decryptRole}
                contractSource={editedContract}
                onContractChange={(newSource) => {
                    setEditedContract(newSource);
                    setContractModified(true);
                }}
                contractModified={contractModified}
                editable={!policyLoaded && pendingPolicies.length === 0}
                onResetContract={() => {
                    setEditedContract(defaultForsetiContract);
                    setContractModified(false);
                }}
            />
        </div>
    );
}
