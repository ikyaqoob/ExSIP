
/**
 * @fileoverview SIP Subscriber (SIP-Specific Event Notifications RFC6665)
 */


/**
 * @augments ExSIP
 * @class Class creating a SIP Subscriber.
 */

ExSIP.Subscriber = function() {};
ExSIP.Subscriber.prototype = {
  /**
   * @private
   */
  initSubscriber: function(ua){
    this.ua = ua;
    this.N = null;
    this.subscriptions = {};

    // Call-ID and CSeq values RFC3261 10.2
    this.call_id = ExSIP.Utils.createRandomToken(22);
    this.cseq = 80;

    // this.to_uri
    this.to_uri = ua.configuration.uri;
    this.contact = ua.contact.toString();
  },

  /**
  * @private
  */
  timer_N: function(){
    this.close();
  },

  /**
  * @private
  */
  close: function() {
    var subscription;

    if (this.state !== 'terminated') {
      if(this.ua.isDebug()) {
        console.log(ExSIP.C.LOG_SUBSCRIBER,'terminating Subscriber');
      }

      this.state = 'terminated';
      window.clearTimeout(this.N);

      for (subscription in this.subscriptions) {
        this.subscriptions[subscription].unsubscribe();
      }

      //Delete subscriber from ua.sessions
      delete this.ua.sessions[this.id];

      this.onTerminate();
    }
  },

  /**
  * @private
  */
  onSubscriptionTerminate: function(subscription) {

    delete this.subscriptions[subscription.id];

    if (Object.keys(this.subscriptions).length === 0) {
      this.close();
    }
  },

  createSubscribeRequest: function(dialog, params) {
    params = params || {};
    params.to_uri = this.to_uri;
    params.call_id = this.call_id;
    params.cseq = this.cseq += 1;
    var extraHeaders = [];
    extraHeaders.push('Contact: '+ this.contact);
    extraHeaders.push('Event: message-summary');
    extraHeaders.push('Date: '+new Date());
    extraHeaders.push('Accept: application/simple-message-summary');
    extraHeaders.push('Allow: '+ ExSIP.Utils.getAllowedMethods(this.ua));

    var request = new ExSIP.OutgoingRequest(ExSIP.C.SUBSCRIBE, this.ua.configuration.registrar_server, this.ua,
      params, extraHeaders);

    return request;
  },

  subscribe: function() {
    var subscriber, from_tag, expires, self = this;

    if (['notify_wait', 'pending', 'active', 'terminated'].indexOf(this.state) !== -1) {
      console.error(ExSIP.C.LOG_SUBSCRIBER,'subscription is already on');
      return;
    }

    subscriber = this;
    from_tag = ExSIP.Utils.newTag();

    new function() {
      this.request = subscriber.createSubscribeRequest(null,{from_tag:from_tag});
      var request_sender = new ExSIP.RequestSender(this, subscriber.ua);

      this.receiveResponse = function(response) {
        switch(true) {
          case /^1[0-9]{2}$/.test(response.status_code): // Ignore provisional responses.
            break;
          case /^2[0-9]{2}$/.test(response.status_code):
            expires = response.s('Expires');

            if (expires && expires <= subscriber.expires) {
              window.clearTimeout(subscriber.N);
              subscriber.N = window.setTimeout(
                function() {subscriber.timer_N();},
                (expires * 1000)
              );
              // Save route set and to tag for backwards compatibility (3265)
              subscriber.route_set_2xx =  response.getHeaderAll('record-route').reverse();
              subscriber.to_tag_2xx = response.s('to').tag;
              subscriber.initial_local_seqnum = parseInt(response.s('cseq').value,10);
            }
            else {
              subscriber.close();

              if (!expires) {
                if(self.ua.isDebug()) {
                  console.warn(ExSIP.C.LOG_SUBSCRIBER,'Expires header missing in a 200-class response to SUBSCRIBE');
                }
                subscriber.onFailure(null, ExSIP.C.EXPIRES_HEADER_MISSING);
              } else {
                if(self.ua.isDebug()) {
                  console.warn(ExSIP.C.LOG_SUBSCRIBER,'Expires header in a 200-class response to SUBSCRIBE with a higher value than the indicated in the request');
                }
                subscriber.onFailure(null, ExSIP.C.INVALID_EXPIRES_HEADER);
              }
            }
            break;
          default:
            subscriber.close();
            subscriber.onFailure(response,null);
            break;
        }
      };

      this.onRequestTimeout = function() {
        subscriber.onFailure(null, ExSIP.C.causes.REQUEST_TIMEOUT);
      };

      this.onTransportError = function() {
        subscriber.onFailure(null, ExSIP.C.causes.CONNECTION_ERROR);
      };

      this.send = function() {
        subscriber.id = this.request.headers['Call-ID'] + from_tag;
        subscriber.ua.sessions[subscriber.id] = subscriber;
        subscriber.state = 'notify_wait';
        subscriber.N = window.setTimeout(
          function() {subscriber.timer_N();},
          (ExSIP.Timers.T1 * 64)
        );
        request_sender.send();
      };
      this.send();
    };

  },

  unsubscribe: function() {
    this.close();
  },

  /**
  * Every Session needs a 'terminate' method in order to be called by ExSIP.UA
  * when user fires ExSIP.UA.close()
  * @private
  */
  terminate: function() {
    this.unsubscribe();
  },

  refresh: function() {
    var subscription;

    for (subscription in this.subscriptions) {
      this.subscriptions[subscription].subscribe();
    }
  },

  /**
  * @private
  */
  receiveRequest: function(request) {
    var subscription_state, expires;

    if (!this.matchEvent(request)) {
      return;
    }

    subscription_state = request.s('Subscription-State');
    expires = subscription_state.expires || this.expires;

    switch (subscription_state.state) {
      case 'pending':
      case 'active':
        //create the subscription.
        window.clearTimeout(this.N);
        new ExSIP.Subscription(this, request, subscription_state.state, expires);
        break;
      case 'terminated':
        if (subscription_state.reason) {
          if(this.ua.isDebug()) {
            console.log(ExSIP.C.LOG_SUBSCRIBER,'terminating subscription with reason '+ subscription_state.reason);
          }
        }
        window.clearTimeout(this.N);
        this.close();
        break;
    }
  },

  /**
  * @private
  */
  matchEvent: function(request) {
    var event;

    // Check mandatory header Event
    if (!request.hasHeader('Event')) {
      if(this.ua.isDebug()) {
        console.warn(ExSIP.C.LOG_SUBSCRIBER,'missing Event header');
      }
      return false;
    }
    // Check mandatory header Subscription-State
    if (!request.hasHeader('Subscription-State')) {
      if(this.ua.isDebug()) {
        console.warn(ExSIP.C.LOG_SUBSCRIBER,'missing Subscription-State header');
      }
      return false;
    }

    // Check whether the event in NOTIFY matches the event in SUBSCRIBE
    event = request.s('event').event;

    if (this.event !== event) {
      if(this.ua.isDebug()) {
        console.warn(ExSIP.C.LOG_SUBSCRIBER,'event match failed');
      }
      request.reply(481, 'Event Match Failed');
      return false;
    } else {
      return true;
    }
  }
};

/**
 * @augments ExSIP
 * @class Class creating a SIP Subscription.
 */
ExSIP.Subscription = function (subscriber, request, state, expires) {

    this.id = null;
    this.subscriber = subscriber;
    this.ua = subscriber.ua;
    this.state = state;
    this.expires = expires;
    this.dialog = null;
    this.N = null;
    this.error_codes  = [404,405,410,416,480,481,482,483,484,485,489,501,604];

    //Create dialog and pass the request to receiveRequest method.
    if (this.createConfirmedDialog(request,'UAS')) {
      this.id = this.dialog.id.toString();
      this.subscriber.subscriptions[this.id] = this;

      /* Update the route_set
      * If the endpoint responded with a 2XX to the initial subscribe
      */
      if (request.from_tag === this.subscriber.to_tag_2xx) {
        this.dialog.route_set = this.subscriber.route_set_2xx;
      }

      this.dialog.local_seqnum = this.subscriber.initial_local_seqnum;

      this.receiveRequest(request, true);
    }
};

ExSIP.Subscription.prototype = {
  /**
  * @private
  */
  timer_N: function(){
    if (this.state === 'terminated') {
      this.close();
    } else if (this.state === 'pending') {
      this.state = 'terminated';
      this.close();
    } else {
      this.subscribe();
    }
  },

  /**
  * @private
  */
  close: function() {
    this.state = 'terminated';
    this.terminateDialog();
    window.clearTimeout(this.N);
    this.subscriber.onSubscriptionTerminate(this);
  },

  /**
  * @private
  */
  createConfirmedDialog: function(message, type) {
    var local_tag, remote_tag, id, dialog;

    // Create a confirmed dialog given a message and type ('UAC' or 'UAS')
    local_tag = (type === 'UAS') ? message.to_tag : message.from_tag;
    remote_tag = (type === 'UAS') ? message.from_tag : message.to_tag;
    id = message.call_id + local_tag + remote_tag;

    dialog = new ExSIP.Dialog(this, message, type);

    if(dialog) {
      this.dialog = dialog;
      return true;
    }
    // Dialog not created due to an error
    else {
      return false;
    }
  },

  /**
  * @private
  */
  terminateDialog: function() {
    if(this.dialog) {
      this.dialog.terminate();
      delete this.dialog;
    }
  },

  /**
  * @private
  */
  receiveRequest: function(request, initial) {
    var subscription_state,
      subscription = this;

    if (!initial && !this.subscriber.matchEvent(request)) {
      if(this.ua.isDebug()) {
        console.warn(ExSIP.C.LOG_SUBSCRIBER,'NOTIFY request does not match event');
      }
      return;
    }

    request.reply(200, ExSIP.C.REASON_200, [
      'Contact: <'+ this.subscriber.contact +'>'
    ]);

    subscription_state = request.s('Subscription-State');

    switch (subscription_state.state) {
      case 'active':
        this.state = 'active';
        this.subscriber.receiveInfo(request);
        /* falls through */
      case 'pending':
        this.expires = subscription_state.expires || this.expires;
        window.clearTimeout(subscription.N);
        subscription.N = window.setTimeout(
          function() {subscription.timer_N();},
          (this.expires * 1000)
        );
        break;
      case 'terminated':
        if (subscription_state.reason) {
          if(this.ua.isDebug()) {
            console.log(ExSIP.C.LOG_SUBSCRIBER,'terminating subscription with reason '+ subscription_state.reason);
          }
        }
        this.close();
        this.subscriber.receiveInfo(request);
        break;
    }
  },

  subscribe: function() {
    var expires,
      subscription = this;

    new function() {
      this.request = subscription.subscriber.createSubscribeRequest(subscription.dialog);

      var request_sender = new ExSIP.RequestSender(this, subscription.subscriber.ua);

      this.receiveResponse = function(response) {
        if (subscription.error_codes.indexOf(response.status_code) !== -1) {
          subscription.close();
          subscription.subscriber.onFailure(response, null);
        } else {
          switch(true) {
            case /^1[0-9]{2}$/.test(response.status_code): // Ignore provisional responses.
              break;
            case /^2[0-9]{2}$/.test(response.status_code):
              expires = response.s('Expires');

              if (expires && expires <= subscription.expires) {
                window.clearTimeout(subscription.N);
                subscription.N = window.setTimeout(
                  function() {subscription.timer_N();},
                  (expires * 1000)
                );
              }else {
                subscription.close();

                if (!expires) {
                  if(subscription.ua.isDebug()) {
                    console.warn(ExSIP.C.LOG_SUBSCRIBER,'Expires header missing in a 200-class response to SUBSCRIBE');
                  }
                  subscription.subscriber.onFailure(null, ExSIP.C.EXPIRES_HEADER_MISSING);
                } else {
                  if(subscription.ua.isDebug()) {
                    console.warn(ExSIP.C.LOG_SUBSCRIBER,'Expires header in a 200-class response to SUBSCRIBE with a higher value than the indicated in the request');
                  }
                  subscription.subscriber.onFailure(null, ExSIP.C.INVALID_EXPIRES_HEADER);
                }
              }
              break;
            default:
              subscription.close();
              subscription.subscriber.onFailure(response,null);
              break;
          }
        }
      };

      this.send = function() {
        window.clearTimeout(subscription.N);
        subscription.N = window.setTimeout(
          function() {subscription.timer_N();},
          (ExSIP.Timers.T1 * 64)
        );
        request_sender.send();
      };

      this.onRequestTimeout = function() {
        subscription.subscriber.onFailure(null, ExSIP.C.causes.REQUEST_TIMEOUT);
      };

      this.onTransportError = function() {
        subscription.subscriber.onFailure(null, ExSIP.C.causes.CONNECTION_ERROR);
      };

      this.send();
    };
  },

  unsubscribe: function() {
    var subscription = this;

    this.state = 'terminated';

    new function() {
      this.request = subscription.subscriber.createSubscribeRequest(subscription.dialog);
      this.request.setHeader('Expires', 0);

      var request_sender = new ExSIP.RequestSender(this, subscription.subscriber.ua);

      //Don't care about response.
      this.receiveResponse = function(){};

      this.send = function() {
        window.clearTimeout(subscription.N);
        subscription.N = window.setTimeout(
          function() {subscription.timer_N();},
          (ExSIP.Timers.T1 * 64)
        );
        request_sender.send();
      };

      this.onRequestTimeout = function() {
        subscription.subscriber.onFailure(null, ExSIP.C.causes.REQUEST_TIMEOUT);
      };
      this.onTransportError = function() {
        subscription.subscriber.onFailure(null, ExSIP.C.causes.CONNECTION_ERROR);
      };

      this.send();
    };
  }
};