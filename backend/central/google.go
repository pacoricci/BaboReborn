package central

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"baboreborn/backend/identity"
)

func (s *Service) login(w http.ResponseWriter, r *http.Request, returnPath string) {
	if s.Verifier == nil {
		identity.Error(w, http.StatusServiceUnavailable, "google_not_configured")
		return
	}
	state, browser, nonce, verifier := identity.Random(), identity.Random(), identity.Random(), oauth2.GenerateVerifier()
	_, err := s.DB.ExecContext(r.Context(), "INSERT INTO oidc_flows(state_hash,browser_hash,verifier,nonce,return_path,expires_at) VALUES($1,$2,$3,$4,$5,$6)", identity.Hash(state), identity.Hash(browser), verifier, nonce, returnPath, s.now().Add(10*time.Minute))
	if err != nil {
		identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	identity.Cookie(w, "central_flow", browser, !s.Development, 600)
	http.Redirect(w, r, s.OAuth.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier), oidc.Nonce(nonce)), http.StatusSeeOther)
}
func (s *Service) callback(w http.ResponseWriter, r *http.Request) {
	if s.Verifier == nil {
		identity.Error(w, http.StatusServiceUnavailable, "google_not_configured")
		return
	}
	browser, err := r.Cookie("central_flow")
	if err != nil {
		identity.Error(w, http.StatusBadRequest, "invalid_state")
		return
	}
	var verifier, nonce, returnPath string
	// Consume the browser-bound state before contacting Google; errors cannot replay it.
	err = s.DB.QueryRowContext(r.Context(), "DELETE FROM oidc_flows WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>$3 RETURNING verifier,nonce,return_path", identity.Hash(r.URL.Query().Get("state")), identity.Hash(browser.Value), s.now()).Scan(&verifier, &nonce, &returnPath)
	if err != nil {
		identity.Error(w, http.StatusBadRequest, "invalid_state")
		return
	}
	identity.Cookie(w, "central_flow", "", !s.Development, -1)
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	token, err := s.OAuth.Exchange(ctx, r.URL.Query().Get("code"), oauth2.VerifierOption(verifier))
	if err != nil {
		identity.Error(w, http.StatusUnauthorized, "google_exchange_failed")
		return
	}
	raw, ok := token.Extra("id_token").(string)
	if !ok {
		identity.Error(w, http.StatusUnauthorized, "google_identity_missing")
		return
	}
	verified, err := s.Verifier.Verify(ctx, raw)
	if err != nil || !identity.Equal(verified.Nonce, nonce) || verified.Subject == "" {
		identity.Error(w, http.StatusUnauthorized, "google_identity_invalid")
		return
	}
	cookie, err := s.createSession(ctx, verified.Issuer, verified.Subject)
	if err != nil {
		identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	identity.Cookie(w, "central_session", cookie, !s.Development, int(identity.SessionLifetime.Seconds()))
	http.Redirect(w, r, returnPath, http.StatusSeeOther)
}
func (s *Service) createSession(ctx context.Context, issuer, subject string) (cookie string, err error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer rollback(tx, &err)
	// Serialize first login for the same external identity, without email matching.
	if _, err = tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", identity.Challenge(issuer+"\x00"+subject)); err != nil {
		return "", err
	}
	var account string
	err = tx.QueryRowContext(ctx, "SELECT account_id FROM external_identities WHERE issuer=$1 AND subject=$2", issuer, subject).Scan(&account)
	if errors.Is(err, sql.ErrNoRows) {
		account = identity.ID()
		if _, err = tx.ExecContext(ctx, "INSERT INTO accounts(id,created_at) VALUES($1,$2)", account, s.now()); err != nil {
			return "", err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO external_identities(issuer,subject,account_id) VALUES($1,$2,$3)", issuer, subject, account); err != nil {
			return "", err
		}
	} else if err != nil {
		return "", err
	}
	cookie = identity.Random()
	now := s.now()
	_, err = tx.ExecContext(ctx, "INSERT INTO sessions(id,credential_hash,account_id,created_at,expires_at) VALUES($1,$2,$3,$4,$5)", identity.ID(), identity.Hash(cookie), account, now, now.Add(identity.SessionLifetime))
	if err != nil {
		return "", err
	}
	err = tx.Commit()
	return cookie, err
}
