// Package ping provides a client for the PING Agent-to-Agent Messenger API.
//
// Example usage:
//
//	client := ping.NewClient("http://localhost:3100")
//	agent, err := client.Register(ctx, "My Agent", nil)
//	result, err := client.Text(ctx, recipientID, "Hello!")
//	messages, err := client.Inbox(ctx)
package ping

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Client is a PING API client.
type Client struct {
	baseURL    string
	httpClient *http.Client
	privateKey ed25519.PrivateKey
	publicKey  string
	AgentID    string
}

// Agent represents a registered agent.
type Agent struct {
	ID           string   `json:"id"`
	PublicKey    string   `json:"publicKey"`
	Name         string   `json:"name"`
	Provider     string   `json:"provider"`
	Capabilities []string `json:"capabilities"`
	WebhookURL   string   `json:"webhookUrl,omitempty"`
	IsPublic     bool     `json:"isPublic"`
	CreatedAt    string   `json:"createdAt"`
}

// Message represents a PING message.
type Message struct {
	ID           string                 `json:"id"`
	Type         string                 `json:"type"`
	From         string                 `json:"from"`
	To           string                 `json:"to"`
	Payload      map[string]interface{} `json:"payload"`
	ReplyTo      string                 `json:"replyTo,omitempty"`
	Timestamp    string                 `json:"timestamp"`
	Signature    string                 `json:"signature"`
	Delivered    bool                   `json:"delivered"`
	Acknowledged bool                   `json:"acknowledged"`
}

// SendResult is the result of sending a message.
type SendResult struct {
	ID             string `json:"id"`
	Delivered      bool   `json:"delivered"`
	DeliveryMethod string `json:"deliveryMethod"`
}

// Contact represents a contact entry.
type Contact struct {
	ContactID string `json:"contactId"`
	Alias     string `json:"alias,omitempty"`
	Notes     string `json:"notes,omitempty"`
	AddedAt   string `json:"addedAt"`
}

// RegisterOptions contains options for registering an agent.
type RegisterOptions struct {
	Provider     string
	Capabilities []string
	WebhookURL   string
	IsPublic     bool
}

// NewClient creates a new PING client.
func NewClient(baseURL string) *Client {
	return &Client{
		baseURL:    baseURL,
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
}

// GenerateKeys generates a new Ed25519 keypair.
func (c *Client) GenerateKeys() (privateKey string, publicKey string, err error) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		return "", "", err
	}
	c.privateKey = priv
	c.publicKey = hex.EncodeToString(pub)
	return hex.EncodeToString(priv), c.publicKey, nil
}

// SetKeys sets the keypair from an existing private key.
func (c *Client) SetKeys(privateKeyHex string) error {
	privBytes, err := hex.DecodeString(privateKeyHex)
	if err != nil {
		return err
	}
	if len(privBytes) != ed25519.PrivateKeySize {
		return fmt.Errorf("invalid private key length: %d", len(privBytes))
	}
	c.privateKey = ed25519.PrivateKey(privBytes)
	c.publicKey = hex.EncodeToString(c.privateKey.Public().(ed25519.PublicKey))
	return nil
}

// Register registers a new agent.
func (c *Client) Register(ctx context.Context, name string, opts *RegisterOptions) (*Agent, error) {
	if c.publicKey == "" {
		_, _, err := c.GenerateKeys()
		if err != nil {
			return nil, err
		}
	}

	body := map[string]interface{}{
		"publicKey": c.publicKey,
		"name":      name,
	}
	if opts != nil {
		if opts.Provider != "" {
			body["provider"] = opts.Provider
		}
		if len(opts.Capabilities) > 0 {
			body["capabilities"] = opts.Capabilities
		}
		if opts.WebhookURL != "" {
			body["webhookUrl"] = opts.WebhookURL
		}
		body["isPublic"] = opts.IsPublic
	}

	var agent Agent
	if err := c.request(ctx, "POST", "/agents", body, &agent); err != nil {
		return nil, err
	}
	c.AgentID = agent.ID
	return &agent, nil
}

// GetAgent gets an agent by ID.
func (c *Client) GetAgent(ctx context.Context, id string) (*Agent, error) {
	var agent Agent
	if err := c.request(ctx, "GET", "/agents/"+id, nil, &agent); err != nil {
		return nil, err
	}
	return &agent, nil
}

// Send sends a message.
func (c *Client) Send(ctx context.Context, to, msgType string, payload map[string]interface{}, replyTo string) (*SendResult, error) {
	if c.AgentID == "" {
		return nil, fmt.Errorf("not registered")
	}

	msg := map[string]interface{}{
		"type":      msgType,
		"from":      c.AgentID,
		"to":        to,
		"payload":   payload,
		"timestamp": time.Now().UnixMilli(),
	}
	if replyTo != "" {
		msg["replyTo"] = replyTo
	}

	// Sign the message
	msgBytes, _ := json.Marshal(msg)
	sig := ed25519.Sign(c.privateKey, msgBytes)
	msg["signature"] = hex.EncodeToString(sig)

	var result SendResult
	if err := c.request(ctx, "POST", "/messages", msg, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Text sends a text message.
func (c *Client) Text(ctx context.Context, to, text string) (*SendResult, error) {
	return c.Send(ctx, to, "text", map[string]interface{}{"text": text}, "")
}

// Ping sends a ping message.
func (c *Client) Ping(ctx context.Context, to string) (*SendResult, error) {
	return c.Send(ctx, to, "ping", nil, "")
}

// Request sends a request message.
func (c *Client) Request(ctx context.Context, to, action string, data interface{}) (*SendResult, error) {
	return c.Send(ctx, to, "request", map[string]interface{}{"action": action, "data": data}, "")
}

// Inbox gets unacknowledged messages.
func (c *Client) Inbox(ctx context.Context) ([]Message, error) {
	if c.AgentID == "" {
		return nil, fmt.Errorf("not registered")
	}

	var messages []Message
	if err := c.request(ctx, "GET", "/agents/"+c.AgentID+"/inbox", nil, &messages); err != nil {
		return nil, err
	}
	return messages, nil
}

// History gets conversation history with another agent.
func (c *Client) History(ctx context.Context, otherID string, limit int) ([]Message, error) {
	if c.AgentID == "" {
		return nil, fmt.Errorf("not registered")
	}
	if limit <= 0 {
		limit = 50
	}

	var messages []Message
	path := fmt.Sprintf("/agents/%s/messages/%s?limit=%d", c.AgentID, otherID, limit)
	if err := c.request(ctx, "GET", path, nil, &messages); err != nil {
		return nil, err
	}
	return messages, nil
}

// Ack acknowledges a message.
func (c *Client) Ack(ctx context.Context, messageID string) error {
	return c.request(ctx, "POST", "/messages/"+messageID+"/ack", nil, nil)
}

// Directory lists public agents.
func (c *Client) Directory(ctx context.Context) ([]Agent, error) {
	var agents []Agent
	if err := c.request(ctx, "GET", "/directory", nil, &agents); err != nil {
		return nil, err
	}
	return agents, nil
}

// SearchOptions contains options for searching agents.
type SearchOptions struct {
	Query      string
	Capability string
	Provider   string
}

// Search searches for agents.
func (c *Client) Search(ctx context.Context, opts *SearchOptions) ([]Agent, error) {
	params := url.Values{}
	if opts != nil {
		if opts.Query != "" {
			params.Set("q", opts.Query)
		}
		if opts.Capability != "" {
			params.Set("capability", opts.Capability)
		}
		if opts.Provider != "" {
			params.Set("provider", opts.Provider)
		}
	}

	path := "/directory/search"
	if len(params) > 0 {
		path += "?" + params.Encode()
	}

	var agents []Agent
	if err := c.request(ctx, "GET", path, nil, &agents); err != nil {
		return nil, err
	}
	return agents, nil
}

// Contacts lists contacts.
func (c *Client) Contacts(ctx context.Context) ([]Contact, error) {
	if c.AgentID == "" {
		return nil, fmt.Errorf("not registered")
	}

	var contacts []Contact
	if err := c.request(ctx, "GET", "/agents/"+c.AgentID+"/contacts", nil, &contacts); err != nil {
		return nil, err
	}
	return contacts, nil
}

// AddContact adds a contact.
func (c *Client) AddContact(ctx context.Context, contactID, alias, notes string) error {
	if c.AgentID == "" {
		return fmt.Errorf("not registered")
	}

	body := map[string]interface{}{
		"contactId": contactID,
	}
	if alias != "" {
		body["alias"] = alias
	}
	if notes != "" {
		body["notes"] = notes
	}

	return c.request(ctx, "POST", "/agents/"+c.AgentID+"/contacts", body, nil)
}

// RemoveContact removes a contact.
func (c *Client) RemoveContact(ctx context.Context, contactID string) error {
	if c.AgentID == "" {
		return fmt.Errorf("not registered")
	}
	return c.request(ctx, "DELETE", "/agents/"+c.AgentID+"/contacts/"+contactID, nil, nil)
}

// request makes an HTTP request to the API.
func (c *Client) request(ctx context.Context, method, path string, body interface{}, result interface{}) error {
	var bodyReader io.Reader
	if body != nil {
		bodyBytes, err := json.Marshal(body)
		if err != nil {
			return err
		}
		bodyReader = bytes.NewReader(bodyBytes)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bodyReader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		var errResp struct {
			Error string `json:"error"`
		}
		json.NewDecoder(resp.Body).Decode(&errResp)
		if errResp.Error != "" {
			return fmt.Errorf("%s", errResp.Error)
		}
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	if result != nil {
		return json.NewDecoder(resp.Body).Decode(result)
	}
	return nil
}
