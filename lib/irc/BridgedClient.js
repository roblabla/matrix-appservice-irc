/*eslint no-invalid-this: 0 */
"use strict";

var Promise = require("bluebird");
var promiseutil = require("../promiseutil");
var util = require("util");
var EventEmitter = require("events").EventEmitter;
var ident = require("./ident");
var ConnectionInstance = require("./ConnectionInstance");
var IrcRoom = require("../models/IrcRoom");
var log = require("../logging").get("BridgedClient");

// The length of time to wait before trying to join the channel again
const JOIN_TIMEOUT_MS = 15 * 1000; // 15s

/**
 * Create a new bridged IRC client.
 * @constructor
 * @param {IrcServer} server
 * @param {IrcClientConfig} ircClientConfig : The IRC user to create a connection for.
 * @param {MatrixUser} matrixUser : Optional. The matrix user representing this virtual IRC user.
 * @param {boolean} isBot : True if this is the bot
 * @param {IrcEventBroker} eventBroker
 * @param {IdentGenerator} identGenerator
 * @param {Ipv6Generator} ipv6Generator
 */
function BridgedClient(server, ircClientConfig, matrixUser, isBot, eventBroker, identGenerator,
                       ipv6Generator) {
    this._eventBroker = eventBroker;
    this._identGenerator = identGenerator;
    this._ipv6Generator = ipv6Generator;
    this._clientConfig = ircClientConfig;
    this.matrixUser = matrixUser;

    this.server = server;
    this.nick = ircClientConfig.getDesiredNick();
    this.password = (
        ircClientConfig.getPassword() ? ircClientConfig.getPassword() : server.config.password
    );
    this.userId = matrixUser ? this.matrixUser.getId() : null;

    this.isBot = Boolean(isBot);
    this.disabled = this.isBot && !server.isBotEnabled();
    this.lastActionTs = Date.now();
    this.inst = null;
    this.instCreationFailed = false;
    this.explicitDisconnect = false;
    this.chanList = [];
    this._connectDefer = promiseutil.defer();
    this._id = (Math.random() * 1e20).toString(36);
    // decorate log lines with the nick and domain, along with an instance id
    var prefix = "<" + this.nick + "@" + this.server.domain + "#" + this._id + "> ";
    if (this.userId) {
        prefix += "(" + this.userId + ") ";
    }
    this.log = {
        debug: function() {
            arguments[0] = prefix + arguments[0];
            log.debug.apply(log, arguments);
        },
        info: function() {
            arguments[0] = prefix + arguments[0];
            log.info.apply(log, arguments);
        },
        error: function() {
            arguments[0] = prefix + arguments[0];
            log.error.apply(log, arguments);
        }
    };
}
util.inherits(BridgedClient, EventEmitter);

BridgedClient.prototype.setClientConfig = function(ircClientConfig) {
    this._clientConfig = ircClientConfig;
};

BridgedClient.prototype.getClientConfig = function() {
    return this._clientConfig;
};

BridgedClient.prototype.isDead = function() {
    if (this.instCreationFailed || (this.inst && this.inst.dead)) {
        return true;
    }
    return false;
};

BridgedClient.prototype.toString = function() {
    let domain = this.server ? this.server.domain : "NO_DOMAIN";
    return `${this.nick}@${domain}#${this._id}~${this.userId}`;
};

/**
 * @return {ConnectionInstance} A new connected connection instance.
 */
BridgedClient.prototype.connect = Promise.coroutine(function*() {
    var server = this.server;
    try {
        let nameInfo = yield this._identGenerator.getIrcNames(
            this._clientConfig, this.matrixUser
        );
        if (this.server.getIpv6Prefix()) {
            // side-effects setting the IPv6 address on the client config
            yield this._ipv6Generator.generate(
                this.server.getIpv6Prefix(), this._clientConfig
            );
        }
        this.log.info(
            "Connecting to IRC server %s as %s (user=%s)",
            server.domain, nameInfo.nick, nameInfo.username
        );
        let connInst = yield ConnectionInstance.create(server, {
            nick: nameInfo.nick,
            username: nameInfo.username,
            realname: nameInfo.realname,
            password: this.password,
            // Don't use stored IPv6 addresses unless they have a prefix else they
            // won't be able to turn off IPv6!
            localAddress: (
                this.server.getIpv6Prefix() ? this._clientConfig.getIpv6Address() : undefined
            )
        }, (inst) => {
            this._onConnectionCreated(inst, nameInfo);
        });

        this.inst = connInst;
        this.unsafeClient = connInst.client;
        this.log.debug("connected!");
        this.emit("client-connected", this);
        // we may have been assigned a different nick, so update it from source
        this.nick = connInst.client.nick;
        this._connectDefer.resolve();
        this._keepAlive();
        connInst.client.addListener("registered", () => {
            var oldNick = this.nick;
            if (oldNick !== this.unsafeClient.nick) {
                this.log.info(
                    "REGISTERED: Nick changed from '" + oldNick + "' to '" +
                    this.unsafeClient.nick + "'."
                );
                this.nick = this.unsafeClient.nick;
                this.emit("nick-change", this, oldNick, this.unsafeClient.nick);
            }
        });
        connInst.client.addListener("nick", (old, newNick) => {
            if (old === this.nick) {
                this.log.info(
                    "NICK: Nick changed from '" + old + "' to '" + newNick + "'."
                );
                this.nick = newNick;
                this.emit("nick-change", this, old, newNick);
            }
        });
        connInst.client.addListener("error", (err) => {
            if (!err || !err.command || connInst.dead) {
                return;
            }
            var msg = "Received an error on " + this.server.domain + ": " + err.command + "\n";
            msg += JSON.stringify(err.args);
            this._eventBroker.sendMetadata(this, msg);
        });
        return connInst;
    }
    catch (err) {
        this.log.debug("Failed to connect.");
        this.instCreationFailed = true;
        throw err;
    }
});

BridgedClient.prototype.disconnect = function(reason) {
    this.explicitDisconnect = true;
    if (!this.inst || this.inst.dead) {
        return Promise.resolve();
    }
    var d = promiseutil.defer();
    this.inst.disconnect(reason, function() {
        d.resolve();
    });
    return d.promise;
};

/**
 * Change this user's nick.
 * @param {string} newNick : The new nick for the user.
 * @return {Promise<String>} Which resolves to a message to be sent to the user.
 */
BridgedClient.prototype.changeNick = function(newNick) {
    // TODO: This is dupe logic with server.js
    // strip illegal chars according to RFC 1459 Sect 2.3.1
    // but allow _ because most IRC servers allow that.
    var nick = newNick.replace(/[^A-Za-z0-9\]\[\^\\\{\}\-`_]/g, "");
    // nicks must start with a letter
    if (!/^[A-Za-z]/.test(nick)) {
        return Promise.reject(
            new Error("Nick '" + nick + "' must start with a letter.")
        );
    }
    var maxNickLen = 9; // RFC 1459 default
    if (this.unsafeClient.supported &&
            typeof this.unsafeClient.supported.nicklength == "number") {
        maxNickLen = this.unsafeClient.supported.nicklength;
    }
    if (nick.length > maxNickLen) {
        return Promise.reject(
            new Error("Nick '" + nick + "' is too long. (Max: " + maxNickLen + ")")
        );
    }
    if (nick === this.nick) {
        return Promise.resolve("Your nick is already '" + nick + "'.");
    }

    var d = promiseutil.defer();
    this.unsafeClient.once("nick", function(old, n) {
        d.resolve("Nick changed from '" + old + "' to '" + n + "'.");
    });
    this.unsafeClient.send("NICK", nick);
    return d.promise;
};

BridgedClient.prototype.joinChannel = function(channel) {
    if (this.disabled) { return Promise.resolve(new IrcRoom(this.server, channel)); }
    return this._joinChannel(channel);
};

BridgedClient.prototype.leaveChannel = function(channel) {
    if (this.disabled) { return Promise.resolve("disabled"); }
    if (!this.inst || this.inst.dead) {
        return Promise.resolve(); // we were never connected to the network.
    }
    if (Object.keys(this.unsafeClient.chans).indexOf(channel) === -1) {
        return Promise.resolve(); // we were never joined to it.
    }
    if (channel.indexOf("#") !== 0) {
        return Promise.resolve(); // PM room
    }
    var self = this;
    var defer = promiseutil.defer();
    this._removeChannel(channel);
    self.log.debug("Leaving channel %s", channel);
    this.unsafeClient.part(channel, "User left", function() {
        self.log.debug("Left channel %s", channel);
        defer.resolve();
    });

    return defer.promise;
};

BridgedClient.prototype.sendAction = function(room, action) {
    if (this.disabled) { return Promise.resolve("disabled"); }
    this._keepAlive();
    switch (action.type) {
        case "message":
            return this._sendMessage(room, "message", action.text);
        case "notice":
            return this._sendMessage(room, "notice", action.text);
        case "emote":
            return this._sendMessage(room, "action", action.text);
        case "topic":
            return this._setTopic(room, action.text);
        default:
            this.log.error("Unknown action type: %s", action.type);
    }
    return Promise.reject(new Error("Unknown action type: " + action.type));
};

BridgedClient.prototype.whois = function(nick) {
    if (this.disabled) {
        return Promise.resolve({
            server: this.server,
            nick: nick
        });
    }
    var defer = promiseutil.defer();
    var self = this;
    this.unsafeClient.whois(nick, function(whois) {
        if (!whois.user) {
            defer.reject(new Error("Cannot find nick on whois."));
            return;
        }
        defer.resolve({
            server: self.server,
            nick: nick
        });
    });
    return defer.promise;
};

BridgedClient.prototype._keepAlive = function() {
    this.lastActionTs = Date.now();
    var idleTimeout = this.server.getIdleTimeoutMs();
    if (idleTimeout > 0) {
        if (this._idleTimeout) {
            // stop the timeout
            clearTimeout(this._idleTimeout);
        }
        this.log.debug(
            "_keepAlive; Restarting %ss idle timeout", idleTimeout
        );
        // restart the timeout
        var self = this;
        this._idleTimeout = setTimeout(function() {
            self.log.info("Idle timeout has expired");
            if (self.server.shouldSyncMembershipToIrc("initial")) {
                self.log.info(
                    "Not disconnecting because %s is mirroring matrix membership lists",
                    self.server.domain
                );
                return;
            }
            if (self.isBot) {
                self.log.info("Not disconnecting because this is the bot");
                return;
            }
            self.disconnect(
                "Idle timeout reached: " + idleTimeout + "s"
            ).done(function() {
                self.log.info("Idle timeout reached: Disconnected");
            }, function(e) {
                self.log.error("Error when disconnecting: %s", JSON.stringify(e));
            });
        }, (1000 * idleTimeout));
    }
};
BridgedClient.prototype._removeChannel = function(channel) {
    var i = this.chanList.indexOf(channel);
    if (i === -1) {
        return;
    }
    this.chanList.splice(i, 1);
};
BridgedClient.prototype._addChannel = function(channel) {
    var i = this.chanList.indexOf(channel);
    if (i !== -1) {
        return; // already added
    }
    this.chanList.push(channel);
};
BridgedClient.prototype.getLastActionTs = function() {
    return this.lastActionTs;
};
BridgedClient.prototype._onConnectionCreated = function(connInst, nameInfo) {
    var self = this;

    // listen for a connect event which is done when the TCP connection is
    // established and set ident info (this is different to the connect() callback
    // in node-irc which actually fires on a registered event..)
    connInst.client.once("connect", function() {
        var localPort = -1;
        if (connInst.client.conn && connInst.client.conn.localPort) {
            localPort = connInst.client.conn.localPort;
        }
        if (localPort > 0) {
            ident.setMapping(nameInfo.username, localPort);
        }
        self._eventBroker.sendMetadata(
            self,
            "You've been connected to the IRC network '" + self.server.domain +
            "' as " + connInst.client.nick + "."
        );
    });

    connInst.onDisconnect = function() {
        self.emit("client-disconnected", self);
        self._eventBroker.sendMetadata(self,
            "Your connection to the IRC network '" + self.server.domain +
            "' has been lost. Reconnecting."
        );
    };

    this._eventBroker.addHooks(this, connInst);
};

BridgedClient.prototype._setTopic = function(room, topic) {
    // join the room if we haven't already
    return this._joinChannel(room.channel).then(() => {
        this.log.info("Setting topic to %s in channel %s", topic, room.channel);
        this.unsafeClient.send("TOPIC", room.channel, topic);
    });
}

BridgedClient.prototype._sendMessage = function(room, msgType, text) {
    // join the room if we haven't already
    var defer = promiseutil.defer();
    msgType = msgType || "message";
    this._connectDefer.promise.then(() => {
        return this._joinChannel(room.channel);
    }).done(() => {
        if (msgType == "action") {
            this.unsafeClient.action(room.channel, text);
        }
        else if (msgType == "notice") {
            this.unsafeClient.notice(room.channel, text);
        }
        else if (msgType == "message") {
            this.unsafeClient.say(room.channel, text);
        }
        defer.resolve();
    }, (e) => {
        this.log.error("sendMessage: Failed to join channel " + room.channel);
        defer.reject(e);
    });
    return defer.promise;
}

BridgedClient.prototype._joinChannel = function(channel, attemptCount) {
    attemptCount = attemptCount || 1;
    if (!this.unsafeClient) {
        return Promise.reject(new Error("No client"));
    }
    if (Object.keys(this.unsafeClient.chans).indexOf(channel) !== -1) {
        return Promise.resolve(new IrcRoom(this.server, channel));
    }
    if (channel.indexOf("#") !== 0) {
        // PM room
        return Promise.resolve(new IrcRoom(this.server, channel));
    }
    if (this.server.isExcludedChannel(channel)) {
        return Promise.reject(new Error(channel + " is a do-not-track channel."));
    }
    var defer = promiseutil.defer();
    this.log.debug("Joining channel %s", channel);
    this._addChannel(channel);
    var client = this.unsafeClient;
    // listen for failures to join a channel (e.g. +i, +k)
    var failFn = (err) => {
        if (!err || !err.args) { return; }
        var failCodes = [
            "err_nosuchchannel", "err_toomanychannels", "err_channelisfull",
            "err_inviteonlychan", "err_bannedfromchan", "err_badchannelkey",
            "err_needreggednick"
        ];
        this.log.error("Join channel %s : %s", channel, err);
        if (failCodes.indexOf(err.command) !== -1 &&
                err.args.indexOf(channel) !== -1) {
            this.log.error("Cannot track channel %s: %s", channel, err.command);
            client.removeListener("error", failFn);
            defer.reject(new Error(err.command));
        }
    };
    client.once("error", failFn);

    // add a timeout to try joining again
    setTimeout(() => {
        // promise isn't resolved yet and we still want to join this channel
        if (defer.promise.isPending() && this.chanList.indexOf(channel) !== -1) {
            // we may have joined but didn't get the callback so check the client
            if (Object.keys(this.unsafeClient.chans).indexOf(channel) !== -1) {
                // we're joined
                this.log.debug("Timed out joining %s - didn't get callback but " +
                    "are now joined. Resolving.", channel);
                defer.resolve(new IrcRoom(this.server, channel));
                return;
            }
            if (attemptCount >= 5) {
                defer.reject(
                    new Error("Failed to join " + channel + " after multiple tries")
                );
                return;
            }

            this.log.error("Timed out trying to join %s - trying again.", channel);
            // try joining again.
            attemptCount += 1;
            this._joinChannel(channel, attemptCount).done(function(s) {
                defer.resolve(s);
            }, function(e) {
                defer.reject(e);
            });
        }
    }, JOIN_TIMEOUT_MS);

    this.unsafeClient.join(channel, () => {
        this.log.debug("Joined channel %s", channel);
        client.removeListener("error", failFn);
        var room = new IrcRoom(this.server, channel);
        defer.resolve(room);
    });

    return defer.promise;
}

module.exports = BridgedClient;
