// Package rdm talks to the DMX gateway to find the fixtures answering on the DMX line.
// The discovery itself runs on the ESP32, where the RDM timings can be met.
package rdm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// ErrUnsupported means the node answering Art-Net is not the Lumières firmware.
var ErrUnsupported = errors.New("Cette passerelle ne sait pas détecter les appareils : flashe le firmware Lumières sur la carte")

// Device is a fixture that answered, as reported by the gateway.
type Device struct {
	UID              string `json:"uid"`
	Manufacturer     string `json:"manufacturer"`
	Model            string `json:"model"`
	Label            string `json:"label"`
	PersonalityName  string `json:"personalityName"`
	Address          int    `json:"address"`
	Footprint        int    `json:"footprint"`
	Personality      int    `json:"personality"`
	PersonalityCount int    `json:"personalityCount"`
}

// Report is the state of the discovery on the gateway.
type Report struct {
	State     string   `json:"state"` // idle, scanning or done
	Truncated bool     `json:"truncated"`
	Devices   []Device `json:"devices"`
}

type Client struct {
	http *http.Client
}

func NewClient() *Client {
	return &Client{http: &http.Client{Timeout: 4 * time.Second}}
}

// Start asks the gateway to look for fixtures.
func (c *Client) Start(ctx context.Context, baseURL string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/rdm/scan", nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return unreachable(err)
	}
	defer resp.Body.Close()
	return checkStatus(resp.StatusCode)
}

// Devices returns where the discovery stands and what has been found so far.
func (c *Client) Devices(ctx context.Context, baseURL string) (*Report, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/rdm/devices", nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, unreachable(err)
	}
	defer resp.Body.Close()
	if err := checkStatus(resp.StatusCode); err != nil {
		return nil, err
	}
	var report Report
	if err := json.NewDecoder(resp.Body).Decode(&report); err != nil {
		return nil, fmt.Errorf("Réponse illisible de la passerelle : %w", err)
	}
	if report.Devices == nil {
		report.Devices = []Device{}
	}
	return &report, nil
}

func unreachable(err error) error {
	return fmt.Errorf("Passerelle DMX injoignable : %w", err)
}

func checkStatus(code int) error {
	switch {
	case code == http.StatusNotFound:
		return ErrUnsupported
	case code >= 300:
		return fmt.Errorf("Passerelle DMX : erreur %d", code)
	}
	return nil
}
