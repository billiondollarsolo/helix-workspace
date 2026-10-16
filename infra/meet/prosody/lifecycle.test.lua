package.path = '/usr/share/lua/5.4/prosody/?.lua;' .. package.path;
package.cpath = '/usr/lib/x86_64-linux-gnu/lua/5.4/prosody/?.so;' .. package.cpath;
local json = require 'util.json';
local saved, hooks, timer, request, response, fail_store;
local next_id, now = 0, 10000;
local real_time, real_getenv = os.time, os.getenv;
os.time = function() return now; end;
os.getenv = function(key)
    if key == 'HELIX_JITSI_WEBHOOK_SECRET' then return string.rep('x', 32); end
    if key == 'HELIX_LIFECYCLE_URL' then return 'http://helix:3000/webhook/jitsi'; end
    return real_getenv(key);
end;
package.loaded['util.uuid'] = { generate = function() next_id = next_id + 1; return 'id-' .. next_id; end };
package.loaded['util.hashes'] = { hmac_sha256 = function(secret, body, hex)
    assert(#secret == 32 and hex and body:match('^%d+%.{')); return 'signature'; end };
package.loaded['net.http'] = { request = function(url, options, callback)
    assert(url == 'http://helix:3000/webhook/jitsi'); request, response = options, callback; end };
package.loaded['util.jid'] = { node = function(value) return value:match('^([^@]+)'); end };
package.loaded['util.stanza'] = { error_reply = function() return 'rejected'; end };
prosody = { full_sessions = {} };
local function boot()
    hooks = {};
    module = {
        require = function() return { is_admin = function(value) return value == 'focus'; end,
            is_healthcheck_room = function() return false; end }; end,
        open_store = function() return {
            get = function() return saved and json.decode(saved); end,
            set = function(_, _, value)
                if fail_store then return nil; end
                saved = json.encode(value); return true;
            end
        }; end,
        hook = function(_, name, callback) hooks[name] = callback; end,
        log = function() end,
        add_timer = function(_, _, callback) timer = callback; end,
    };
    dofile(arg[1] or '/tests/mod_helix_lifecycle.lua');
end
local function event(id, overrides)
    local user = { id = id, helixOrgId = 'org', helixRoomId = 'room' };
    for k, v in pairs(overrides or {}) do user[k] = v; end
    return { room = { jid = 'room@muc' }, occupant = { bare_jid = id, jid = 'room@muc/' .. id },
        origin = { auth_token = 'verified', jitsi_meet_context_user = user, send = function(value) assert(value == 'rejected'); end } };
end
local function pending() return json.decode(saved).pending; end
boot();
local alice, bob = event('alice'), event('bob');
hooks['muc-occupant-joined'](alice);
hooks['muc-occupant-joined'](alice);
hooks['muc-occupant-joined'](bob);
assert(#pending() == 3, 'duplicate join must not emit twice');
assert(hooks['muc-occupant-pre-join'](event('mallory', {helixOrgId='other'})) == true, 'reject tenant mismatch');
local untrusted = event('spoof'); untrusted.origin.auth_token = nil;
hooks['muc-occupant-joined'](untrusted);
assert(#pending() == 3, 'ignore unverified identity');
timer(); local first = request.body;
assert(request.headers['X-Helix-Signature']:match('^t=10000,v1=signature$'));
response('', nil); now = now + 3; timer();
assert(request.body == first, 'retry preserves event ID and timestamp');
response('', 200); assert(#pending() == 2);
hooks['muc-occupant-left'](alice);
local left = json.decode(pending()[3]); local joined = json.decode(pending()[1]);
assert(left.sessionId == joined.sessionId and left.participantId == 'alice');
fail_store = true; hooks['muc-occupant-left'](bob);
assert(hooks['muc-occupant-pre-join'](event('new')) == true, 'reject new joins while storage fails');
fail_store = false; now = now + 3; timer(); response('', 200);
boot();
assert(#pending() == 3, 'persist departures and recover without duplicate closed sessions');
hooks['muc-occupant-joined'](alice);
local before = #pending(); boot();
assert(#pending() == before + 1, 'restart emits departure for lost connection');
hooks['muc-occupant-joined'](alice);
hooks['muc-room-destroyed'](alice);
assert(json.decode(pending()[#pending()]).event == 'conference.ended');
print('Lifecycle: verified identity, duplicate joins, durable retries, storage failure, departures and restart passed');
