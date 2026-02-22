"""
PING Python SDK Client

Zero dependencies (just standard library + optional nacl for Ed25519).
"""

import json
import urllib.request
import urllib.error
from typing import Optional, List, Dict, Any
from dataclasses import dataclass
import os

# Optional: use PyNaCl for Ed25519 if available
try:
    from nacl.signing import SigningKey, VerifyKey
    from nacl.encoding import HexEncoder
    NACL_AVAILABLE = True
except ImportError:
    NACL_AVAILABLE = False


class PingError(Exception):
    """Error from PING API"""
    def __init__(self, message: str, status_code: int = 500):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class Agent:
    id: str
    public_key: str
    name: str
    provider: str
    capabilities: List[str]
    webhook_url: Optional[str]
    is_public: bool
    created_at: str


@dataclass
class Message:
    id: str
    type: str
    from_agent: str
    to_agent: str
    payload: Dict[str, Any]
    reply_to: Optional[str]
    timestamp: str
    signature: str
    delivered: bool = False
    acknowledged: bool = False


@dataclass
class Contact:
    contact_id: str
    alias: Optional[str]
    notes: Optional[str]
    added_at: str
    contact: Optional[Dict[str, Any]]


class PingClient:
    """
    PING SDK Client
    
    Example:
        client = PingClient()
        client.generate_keys()
        agent = client.register(name="My Agent")
        client.text(recipient_id, "Hello!")
        messages = client.inbox()
    """
    
    def __init__(
        self,
        base_url: str = "http://localhost:3100",
        private_key: Optional[str] = None,
        agent_id: Optional[str] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.agent_id = agent_id or ""
        self._signing_key: Optional[Any] = None
        self._public_key = ""
        
        if private_key:
            self.set_keys(private_key)
    
    # ═══════════════════════════════════════════════════════════════
    #                         KEYS
    # ═══════════════════════════════════════════════════════════════
    
    def generate_keys(self) -> Dict[str, str]:
        """Generate a new Ed25519 keypair"""
        if not NACL_AVAILABLE:
            raise PingError("PyNaCl not installed. Run: pip install pynacl", 500)
        
        self._signing_key = SigningKey.generate()
        self._public_key = self._signing_key.verify_key.encode(encoder=HexEncoder).decode()
        
        return {
            "private_key": self._signing_key.encode(encoder=HexEncoder).decode(),
            "public_key": self._public_key,
        }
    
    def set_keys(self, private_key: str) -> None:
        """Set keys from existing private key"""
        if not NACL_AVAILABLE:
            raise PingError("PyNaCl not installed. Run: pip install pynacl", 500)
        
        self._signing_key = SigningKey(private_key, encoder=HexEncoder)
        self._public_key = self._signing_key.verify_key.encode(encoder=HexEncoder).decode()
    
    @property
    def public_key(self) -> str:
        """Get the public key"""
        return self._public_key
    
    # ═══════════════════════════════════════════════════════════════
    #                         AGENTS
    # ═══════════════════════════════════════════════════════════════
    
    def register(
        self,
        name: str,
        provider: str = "python",
        capabilities: Optional[List[str]] = None,
        webhook_url: Optional[str] = None,
        is_public: bool = False,
    ) -> Agent:
        """Register as a new agent"""
        if not self._public_key:
            self.generate_keys()
        
        data = self._request("POST", "/agents", {
            "publicKey": self._public_key,
            "name": name,
            "provider": provider,
            "capabilities": capabilities or [],
            "webhookUrl": webhook_url,
            "isPublic": is_public,
        })
        
        self.agent_id = data["id"]
        return Agent(
            id=data["id"],
            public_key=data["publicKey"],
            name=data["name"],
            provider=data["provider"],
            capabilities=data.get("capabilities", []),
            webhook_url=data.get("webhookUrl"),
            is_public=data.get("isPublic", False),
            created_at=data.get("createdAt", ""),
        )
    
    def get_agent(self, agent_id: str) -> Agent:
        """Get agent info by ID"""
        data = self._request("GET", f"/agents/{agent_id}")
        return Agent(
            id=data["id"],
            public_key=data["publicKey"],
            name=data["name"],
            provider=data["provider"],
            capabilities=data.get("capabilities", []),
            webhook_url=data.get("webhookUrl"),
            is_public=data.get("isPublic", False),
            created_at=data.get("createdAt", ""),
        )
    
    def delete_agent(self) -> None:
        """Delete this agent"""
        self._require_agent()
        self._request("DELETE", f"/agents/{self.agent_id}")
        self.agent_id = ""
    
    # ═══════════════════════════════════════════════════════════════
    #                         DIRECTORY
    # ═══════════════════════════════════════════════════════════════
    
    def directory(self) -> List[Dict[str, Any]]:
        """List public agents"""
        return self._request("GET", "/directory")
    
    def search(
        self,
        query: Optional[str] = None,
        capability: Optional[str] = None,
        provider: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Search agents"""
        params = []
        if query:
            params.append(f"q={query}")
        if capability:
            params.append(f"capability={capability}")
        if provider:
            params.append(f"provider={provider}")
        
        path = "/directory/search"
        if params:
            path += "?" + "&".join(params)
        
        return self._request("GET", path)
    
    # ═══════════════════════════════════════════════════════════════
    #                         CONTACTS
    # ═══════════════════════════════════════════════════════════════
    
    def contacts(self) -> List[Contact]:
        """Get contacts"""
        self._require_agent()
        data = self._request("GET", f"/agents/{self.agent_id}/contacts")
        return [
            Contact(
                contact_id=c["contactId"],
                alias=c.get("alias"),
                notes=c.get("notes"),
                added_at=c.get("addedAt", ""),
                contact=c.get("contact"),
            )
            for c in data
        ]
    
    def add_contact(
        self,
        contact_id: str,
        alias: Optional[str] = None,
        notes: Optional[str] = None,
    ) -> None:
        """Add a contact"""
        self._require_agent()
        self._request("POST", f"/agents/{self.agent_id}/contacts", {
            "contactId": contact_id,
            "alias": alias,
            "notes": notes,
        })
    
    def remove_contact(self, contact_id: str) -> None:
        """Remove a contact"""
        self._require_agent()
        self._request("DELETE", f"/agents/{self.agent_id}/contacts/{contact_id}")
    
    # ═══════════════════════════════════════════════════════════════
    #                         MESSAGES
    # ═══════════════════════════════════════════════════════════════
    
    def send(
        self,
        to: str,
        msg_type: str,
        payload: Optional[Dict[str, Any]] = None,
        reply_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send a message"""
        self._require_agent()
        self._require_keys()
        
        import time
        
        message = {
            "type": msg_type,
            "from": self.agent_id,
            "to": to,
            "payload": payload or {},
            "replyTo": reply_to,
            "timestamp": int(time.time() * 1000),
        }
        
        signature = self._sign(message)
        
        return self._request("POST", "/messages", {
            **message,
            "signature": signature,
        })
    
    def inbox(self, include_all: bool = False) -> List[Message]:
        """Get inbox (unacknowledged messages)"""
        self._require_agent()
        path = f"/agents/{self.agent_id}/inbox"
        if include_all:
            path += "?all=true"
        
        data = self._request("GET", path)
        return [
            Message(
                id=m["id"],
                type=m["type"],
                from_agent=m["from"],
                to_agent=m["to"],
                payload=m.get("payload", {}),
                reply_to=m.get("replyTo"),
                timestamp=m.get("timestamp", ""),
                signature=m.get("signature", ""),
                delivered=m.get("delivered", False),
                acknowledged=m.get("acknowledged", False),
            )
            for m in data
        ]
    
    def history(self, other_id: str, limit: int = 50) -> List[Message]:
        """Get conversation history"""
        self._require_agent()
        data = self._request("GET", f"/agents/{self.agent_id}/messages/{other_id}?limit={limit}")
        return [
            Message(
                id=m["id"],
                type=m["type"],
                from_agent=m["from"],
                to_agent=m["to"],
                payload=m.get("payload", {}),
                reply_to=m.get("replyTo"),
                timestamp=m.get("timestamp", ""),
                signature=m.get("signature", ""),
            )
            for m in data
        ]
    
    def ack(self, message_id: str) -> None:
        """Acknowledge a message"""
        self._request("POST", f"/messages/{message_id}/ack")
    
    # ═══════════════════════════════════════════════════════════════
    #                    CONVENIENCE METHODS
    # ═══════════════════════════════════════════════════════════════
    
    def text(self, to: str, text: str) -> Dict[str, Any]:
        """Send a text message"""
        return self.send(to, "text", {"text": text})
    
    def ping(self, to: str) -> Dict[str, Any]:
        """Send a ping"""
        return self.send(to, "ping", {})
    
    def pong(self, to: str, reply_to: Optional[str] = None) -> Dict[str, Any]:
        """Send a pong (reply to ping)"""
        return self.send(to, "pong", {}, reply_to)
    
    def request(self, to: str, action: str, data: Any = None) -> Dict[str, Any]:
        """Send a request"""
        return self.send(to, "request", {"action": action, "data": data})
    
    def respond(self, to: str, result: Any, reply_to: Optional[str] = None) -> Dict[str, Any]:
        """Send a response"""
        return self.send(to, "response", {"result": result}, reply_to)
    
    def propose(self, to: str, proposal: Dict[str, Any]) -> Dict[str, Any]:
        """Send a proposal (for signing)"""
        return self.send(to, "proposal", proposal)
    
    def signature(self, to: str, sig: str, reply_to: Optional[str] = None) -> Dict[str, Any]:
        """Send a signature"""
        return self.send(to, "signature", {"signature": sig}, reply_to)
    
    # ═══════════════════════════════════════════════════════════════
    #                         INTERNALS
    # ═══════════════════════════════════════════════════════════════
    
    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Make HTTP request to API"""
        url = f"{self.base_url}{path}"
        
        data = None
        headers = {}
        
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        
        try:
            with urllib.request.urlopen(req) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                error_data = json.loads(e.read().decode("utf-8"))
                raise PingError(error_data.get("error", str(e)), e.code)
            except json.JSONDecodeError:
                raise PingError(str(e), e.code)
    
    def _sign(self, message: Dict[str, Any]) -> str:
        """Sign a message with Ed25519"""
        msg_bytes = json.dumps(message).encode("utf-8")
        signed = self._signing_key.sign(msg_bytes)
        return signed.signature.hex()
    
    def _require_agent(self) -> None:
        """Ensure agent is registered"""
        if not self.agent_id:
            raise PingError("Must register first (call register())", 400)
    
    def _require_keys(self) -> None:
        """Ensure keys are set"""
        if not self._signing_key:
            raise PingError("Must generate or set keys first", 400)
