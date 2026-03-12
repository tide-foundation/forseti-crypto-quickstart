'use client'

import { useCallback, useEffect } from 'react'
import { IAMService } from '@tidecloak/js'
import { useAuth } from '@/hooks/useAuth'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
    const { isAuthenticated, isLoading } = useAuth()
    const router = useRouter()

    useEffect(() => {
        if (isAuthenticated) {
            router.push('/home')
        }
    }, [isAuthenticated, router])

    const onLogin = useCallback(() => {
        IAMService.doLogin();
    }, [])

    if (isLoading) {
        return (
            <div className="page-container">
                <p style={{ color: 'var(--text-muted)' }}>Loading...</p>
            </div>
        )
    }

    return (
        <div className="page-container">
            <div className="login-card">
                <div className="login-header">
                    <h1>Forseti Crypto Quickstart</h1>
                    <p>
                        Policy-enabled encryption and decryption using a Forseti smart contract with TideCloak.
                    </p>
                </div>
                <div className="login-body">
                    <button onClick={onLogin} className="btn btn-primary btn-lg" style={{ width: '100%' }}>
                        Log In with TideCloak
                    </button>
                    <div className="login-features">
                        <div className="login-feature">
                            <span className="login-feature-icon">1</span>
                            <span>Authenticate with TideCloak</span>
                        </div>
                        <div className="login-feature">
                            <span className="login-feature-icon">2</span>
                            <span>Create &amp; approve an encryption policy</span>
                        </div>
                        <div className="login-feature">
                            <span className="login-feature-icon">3</span>
                            <span>Encrypt &amp; decrypt data with policy controls</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
