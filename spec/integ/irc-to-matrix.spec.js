/*
 * Contains integration tests for all IRC-initiated events.
 */
"use strict";
var Promise = require("bluebird");
var test = require("../util/test");

// set up integration testing mocks
var env = test.mkEnv();

// set up test config
var config = env.config;
var roomMapping = {
    server: config._server,
    botNick: config._botnick,
    channel: config._chan,
    roomId: config._roomid
};

describe("IRC-to-Matrix message bridging", function() {
    var sdk = null;

    var tFromNick = "mike";
    var tUserId = "@" + roomMapping.server + "_" + tFromNick + ":" +
                  config.homeserver.domain;

    var checksum = function(str) {
        var total = 0;
        for (var i = 0; i < str.length; i++) {
            total += str.charCodeAt(i);
        }
        return total;
    };

    beforeEach(function(done) {
        test.beforeEach(this, env); // eslint-disable-line no-invalid-this

        sdk = env.clientMock._client(tUserId);
        // add registration mock impl:
        // registering should be for the irc user
        sdk._onHttpRegister({
            expectLocalpart: roomMapping.server + "_" + tFromNick,
            returnUserId: tUserId
        });

        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        // do the init
        test.initEnv(env).done(function() {
            done();
        });
    });

    it("should bridge IRC text as Matrix message's m.text",
    function(done) {
        var testText = "this is some test text.";
        sdk.sendEvent.andCallFake(function(roomId, type, content) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(content).toEqual({
                body: testText,
                msgtype: "m.text"
            });
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit("message", tFromNick, roomMapping.channel, testText);
        });
    });

    it("should bridge IRC actions as Matrix message's m.emote",
    function(done) {
        var testEmoteText = "thinks for a bit";
        sdk.sendEvent.andCallFake(function(roomId, type, content) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(content).toEqual({
                body: testEmoteText,
                msgtype: "m.emote"
            });
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit("ctcp-privmsg",
                tFromNick, roomMapping.channel, "ACTION " + testEmoteText
            );
        });
    });

    it("should bridge IRC notices as Matrix message's m.notice",
    function(done) {
        var testNoticeText = "Automated bot text: SUCCESS!";
        sdk.sendEvent.andCallFake(function(roomId, type, content) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(content).toEqual({
                body: testNoticeText,
                msgtype: "m.notice"
            });
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit(
                "notice", tFromNick, roomMapping.channel, testNoticeText
            );
        });
    });

    it("should bridge IRC topics as Matrix m.room.topic",
    function(done) {
        var testTopic = "Topics are liek the best thing evarz!";
        sdk.sendStateEvent.andCallFake(function(roomId, type, content, skey) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(content).toEqual({ topic: testTopic });
            expect(type).toEqual("m.room.topic");
            expect(skey).toEqual("");
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit("topic", roomMapping.channel, testTopic, tFromNick);
        });
    });

    it("should be insensitive to the case of the channel",
    function(done) {
        var testText = "this is some test text.";
        sdk.sendEvent.andCallFake(function(roomId, type, content) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(content).toEqual({
                body: testText,
                msgtype: "m.text"
            });
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit(
                "message", tFromNick, roomMapping.channel.toUpperCase(), testText
            );
        });
    });

    it("should bridge IRC formatted text as Matrix's org.matrix.custom.html",
    function(done) {
        var tIrcFormattedText = "This text is \u0002bold\u000f and this is " +
            "\u001funderlined\u000f and this is \u000303green\u000f. Finally, " +
            "this is a \u0002\u001f\u000303mix of all three";
        var tHtmlCloseTags = "</b></u></font>"; // any order allowed
        var tHtmlMain = "This text is <b>bold</b> and this is <u>underlined</u> " +
            'and this is <font color="green">green</font>. Finally, ' +
            'this is a <b><u><font color="green">mix of all three';
        var tFallback = "This text is bold and this is underlined and this is " +
            "green. Finally, this is a mix of all three";
        sdk.sendEvent.andCallFake(function(roomId, type, content) {
            expect(roomId).toEqual(roomMapping.roomId);
            // more readily expose non-printing character errors (looking at
            // you \u000f)
            expect(content.body.length).toEqual(tFallback.length);
            expect(content.body).toEqual(tFallback);
            expect(content.format).toEqual("org.matrix.custom.html");
            expect(content.msgtype).toEqual("m.text");
            expect(content.formatted_body.indexOf(tHtmlMain)).toEqual(0);
            // we allow any order of close tags here, so just do a checksum on
            // the remainder
            expect(
                checksum(content.formatted_body.substring(tHtmlMain.length))
            ).toEqual(
                checksum(tHtmlCloseTags)
            );
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit(
                "message", tFromNick, roomMapping.channel, tIrcFormattedText
            );
        });
    });

    it("should html escape IRC text", function(done) {
        var tIrcFormattedText = "This text is \u0002bold\u000f and has " +
            "<div> tags & characters like ' and \"";
        var tHtmlMain = "This text is <b>bold</b> and has " +
            "&lt;div&gt; tags &amp; characters like &#39; and &quot;";
        var tFallback = "This text is bold and has <div> tags & characters like ' and \"";
        sdk.sendEvent.andCallFake(function(roomId, type, content) {
            expect(roomId).toEqual(roomMapping.roomId);
            // more readily expose non-printing character errors (looking at
            // you \u000f)
            expect(content.body.length).toEqual(tFallback.length);
            expect(content.body).toEqual(tFallback);
            expect(content.format).toEqual("org.matrix.custom.html");
            expect(content.msgtype).toEqual("m.text");
            expect(content.formatted_body).toEqual(tHtmlMain);
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit(
                "message", tFromNick, roomMapping.channel, tIrcFormattedText
            );
        });
    });
});

describe("IRC-to-Matrix name bridging", function() {
    var sdk;
    var tFromNick = "mike";
    var tUserId = "@" + roomMapping.server + "_" + tFromNick + ":" +
                  config.homeserver.domain;

    beforeEach(function(done) {
        test.beforeEach(this, env); // eslint-disable-line no-invalid-this

        config.ircService.servers[roomMapping.server].matrixClients.displayName = (
            "Test $NICK and $SERVER"
        );

        sdk = env.clientMock._client(tUserId);

        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        test.initEnv(env).done(function() {
            done();
        });
    });

    it("should set the matrix display name from the config file template", function(done) {
        // don't care about registration / sending the event
        sdk.sendEvent.andCallFake(function(roomId, type, content) {
            return Promise.resolve();
        });
        sdk.register.andCallFake(function(username, password) {
            return Promise.resolve({
                user_id: tUserId
            });
        });

        sdk.setDisplayName.andCallFake(function(name) {
            expect(name).toEqual("Test mike and " + roomMapping.server);
            done();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit("message", tFromNick, roomMapping.channel, "ping");
        });
    });
});
