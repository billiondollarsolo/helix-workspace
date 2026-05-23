// Override Jitsi's PUBLIC_URL-derived BOSH/WebSocket endpoints so they always
// match the origin the page was loaded from. Upstream's system-config.js
// hard-codes 'https://' + PUBLIC_URL, which can't produce HTTP/WS endpoints
// in dev and can't react to whatever host an operator fronts Jitsi at in
// prod. Reading window.location keeps a single file portable across local
// docker-compose, prod docker-compose, and Kubernetes — the ingress decides
// the scheme + host and the client just inherits it.
//
// Appended verbatim after system-config.js by /etc/cont-init.d/10-config;
// later assignment wins.
var wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
config.bosh = window.location.origin + '/http-bind';
config.websocket = wsProto + '//' + window.location.host + '/xmpp-websocket';
