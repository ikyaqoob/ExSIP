module( "incoming call", {
  setup: function() {
    ua = TestExSIP.Helpers.createFakeUA({trace_sip: true, use_preloaded_route: false});
    ua.on('newRTCSession', function(e){ session = e.data.session; });
    TestExSIP.Helpers.mockWebRTC();
    TestExSIP.Helpers.start(ua);

  }, teardown: function() {
  }
});
test('terminate before answering', function() {
  ua.transport.onMessage({data: TestExSIP.Helpers.initialInviteRequest(ua, {})});
  session.terminate();
  var answerMsg = TestExSIP.Helpers.popMessageSent();
  strictEqual(answerMsg.status_code, 486, "Should send a 486 response");
});
test('with Firefox and null candidate', function() {
  ua.transport.onMessage({data: TestExSIP.Helpers.initialInviteRequest(ua, {})});
  window.mozRTCPeerConnection = {};
  session.answer();
  TestExSIP.Helpers.triggerOnIceCandidate(session, {withoutCandidate: true});
  var answerMsg = TestExSIP.Helpers.popMessageSent(ua);
  strictEqual(answerMsg.status_code, 200);
  window.mozRTCPeerConnection = undefined;
});
test('initial invite without sdp', function() {
  ua.transport.onMessage({data: TestExSIP.Helpers.initialInviteRequest(ua, {noSdp: true})});
  session.answer();
  TestExSIP.Helpers.triggerOnIceCandidate(session);
  var answerMsg = TestExSIP.Helpers.popMessageSent(ua);
  strictEqual(answerMsg.status_code, 200);
  notStrictEqual(answerMsg.body, '', 'should have sdp');
});
test('INFO received after INVITE', function() {
  var answerMsg = TestExSIP.Helpers.receiveInviteAndAnswer();
  var started = false;
  session.on('started', function(e) {
    started = true;
  });
  var sdp = '<?xml version="1.0" encoding="utf-8"?>\r\n'+
    '<media_control>\r\n'+
    '<vc_primitive>\r\n'+
    '<to_encoder>\r\n'+
    '<picture_fast_update/>\r\n'+
    '</to_encoder>\r\n'+
    '</vc_primitive>\r\n'+
    '</media_control>\r\n'+
    '\r\n';
  TestExSIP.Helpers.requestFor(answerMsg, {method: 'INFO',
    content_type: 'application/media_control+xml', branch: 'z9hG4bK-524287-1---8b28117fe385ce21', sdp: sdp});

  var infoAnswerMsg = TestExSIP.Helpers.popMessageSent(ua);
  strictEqual(infoAnswerMsg.status_code, 200);
  strictEqual(started, true, "should trigger started in order to update video streams");
});
