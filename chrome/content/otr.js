let EXPORTED_SYMBOLS = ["otr"];

const { interfaces: Ci, utils: Cu, classes: Cc } = Components;

Cu.import("resource://gre/modules/ctypes.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/osfile.jsm");
Cu.import("chrome://otr/content/libotr.js");

// translations

let bundle = Services.strings.createBundle("chrome://otr/locale/otr.properties");

function trans(name) {
  let args = Array.prototype.slice.call(arguments, 1);
  return args.length > 0
    ? bundle.formatStringFromName(name, args, args.length)
    : bundle.GetStringFromName(name);
}

// some helpers

function ensureFileExists(path) {
  return OS.File.exists(path).then(exists => {
    if (!exists)
      return OS.File.open(path, { create: true }).then(file => {
        return file.close()
      });
  });
}

function profilePath(filename) {
  return OS.Path.join(OS.Constants.Path.profileDir, filename);
}

// libotr context wrapper

function Context(context) {
  this.context = context;
}

Context.prototype = {
  constructor: Context,
  get username() this.context.contents.username.readString(),
  get account() this.context.contents.accountname.readString(),
  get protocol() this.context.contents.protocol.readString(),
  get msgstate() this.context.contents.msgstate,
  get trust() {
    let afp = this.context.contents.active_fingerprint;
    return (!afp.isNull() &&
      !afp.contents.trust.isNull() &&
      afp.contents.trust.readString().length > 0);
  }
};

// otr module

let otr = {

  init: function(opts) {
    opts = opts || {};

    libOTR.init();
    this.setPolicy(opts.requireEncryption);

    this.userstate = libOTR.otrl_userstate_create();
    this.privateKeyPath = profilePath("otr.private_key")
    this.fingerprintsPath = profilePath("otr.fingerprints");
    this.instanceTagsPath = profilePath("otr.instance_tags");
    this.uiOps = this.initUiOps();

    // A map of UIConvs, keyed on the target.id
    this._convos = new Map();
    this._observers = [];
    this._buffer = [];
  },

  close: () => libOTR.close(),

  log: function(msg) {
    this.notifyObservers(msg, "otr:log");
  },

  setPolicy: function(requireEncryption) {
    this.policy = requireEncryption
      ? libOTR.OTRL_POLICY_ALWAYS
      : libOTR.OTRL_POLICY_OPPORTUNISTIC;
  },

  // load stored files from my profile
  loadFiles: function() {
    return ensureFileExists(this.privateKeyPath).then(() => {
      let err = libOTR.otrl_privkey_read(this.userstate, this.privateKeyPath);
      if (err)
        throw new Error("Returned code: " + err);
    }).then(() => ensureFileExists(this.fingerprintsPath)).then(() => {
      let err = libOTR.otrl_privkey_read_fingerprints(
        this.userstate, this.fingerprintsPath, null, null
      );
      if (err)
        throw new Error("Returned code: " + err);
    }).then(() => ensureFileExists(this.instanceTagsPath));
  },
  
  // generate a private key
  // TODO: maybe move this to a ChromeWorker
  generatePrivateKey: function(account, protocol) {
    let err = libOTR.otrl_privkey_generate(
      this.userstate, this.privateKeyPath, account, protocol
    );
    if (err)
      throw new Error("Returned code: " + err);
  },

  // get my fingerprint
  privateKeyFingerprint: function(account, protocol) {
    let fingerprint = libOTR.otrl_privkey_fingerprint(
      this.userstate, new libOTR.fingerprint_t(), account, protocol
    );
    return fingerprint.isNull() ? null : fingerprint.readString();
  },

  // write fingerprints to file synchronously
  writeFingerprints: function() {
    let err = libOTR.otrl_privkey_write_fingerprints(
      this.userstate, this.fingerprintsPath
    );
    if (err)
      throw new Error("Returned code: " + err);
  },

  // write fingerprints to file synchronously
  genInstag: function(account, protocol) {
    let err = libOTR.otrl_instag_generate(
      this.userstate, this.instanceTagsPath, account, protocol
    );
    if (err)
      throw new Error("Returned code: " + err);
  },

  // expose message states
  messageState: libOTR.messageState,

  // get context from conv
  getContext: function(conv) {
    let context = libOTR.otrl_context_find(
      this.userstate,
      conv.normalizedName,
      conv.account.normalizedName,
      conv.account.protocol.normalizedName,
      libOTR.OTRL_INSTAG_BEST, 1, null, null, null
    );
    return new Context(context);
  },

  getUIConvFromContext: function(context) {
    return this.getUIConvForRecipient(
      context.account, context.protocol, context.username
    );
  },

  getUIConvForRecipient: function(account, protocol, recipient) {
    let uiConvs = this._convos.values();
    let uiConv = uiConvs.next();
    while (!uiConv.done) {
      let conv = uiConv.value.target;
      if (conv.account.normalizedName === account &&
          conv.account.protocol.normalizedName === protocol &&
          conv.normalizedName === recipient)
        return uiConv.value;
      uiConv = uiConvs.next();
    }
    return null;
  },

  disconnect: function(conv, remove) {
    libOTR.otrl_message_disconnect(
      this.userstate,
      this.uiOps.address(),
      null,
      conv.account.normalizedName,
      conv.account.protocol.normalizedName,
      conv.normalizedName,
      libOTR.OTRL_INSTAG_BEST
    );
    if (remove) {
      let uiConv = Services.conversations.getUIConversation(conv);
      this.removeConversation(uiConv);
    } else
      this.notifyObservers(this.getContext(conv), "otr:msg-state");
  },

  sendQueryMsg: function(conv) {
    let query = libOTR.otrl_proto_default_query_msg(
      conv.account.normalizedName,
      this.policy
    );
    conv.sendMsg(query.readString());
    libOTR.otrl_message_free(query);
  },

  trustState: {
    TRUST_NOT_PRIVATE: 0,
    TRUST_UNVERIFIED: 1,
    TRUST_PRIVATE: 2,
    TRUST_FINISHED: 3
  },

  trust: function(context) {
    let level = this.trustState.TRUST_NOT_PRIVATE;
    switch(context.msgstate) {
    case this.messageState.OTRL_MSGSTATE_ENCRYPTED:
      level = context.trust
        ? this.trustState.TRUST_PRIVATE
        : this.trustState.TRUST_UNVERIFIED;
      break;
    case this.messageState.OTRL_MSGSTATE_FINISHED:
      level = this.trustState.TRUST_FINISHED;
      break;
    }
    return level;
  },

  // uiOps callbacks

  policy_cb: function(opdata, context) {
    return this.policy;
  },

  create_privkey_cb: function(opdata, accountname, protocol) {
    this.generatePrivateKey(accountname.readString(), protocol.readString());
  },

  is_logged_in_cb: function(opdata, accountname, protocol, recipient) {
    // FIXME: ask the ui if this is true
    return 1;
  },

  inject_message_cb: function(opdata, accountname, protocol, recipient, message) {
    let aMsg = message.readString();
    this.log("inject_message_cb (msglen:" + aMsg.length + "): " + aMsg);
    let uiConv = this.getUIConvForRecipient(
      accountname.readString(),
      protocol.readString(),
      recipient.readString()
    );
    if (uiConv)
      uiConv.target.sendMsg(aMsg);
    else
      Cu.reportError("Couldn't find conversation to inject.");
  },

  update_context_list_cb: function(opdata) {
    this.log("update_context_list_cb");
  },

  new_fingerprint_cb: function(opdata, us, accountname, protocol, username, fingerprint) {
    this.log("new_fingerprint_cb");
  },

  write_fingerprint_cb: function(opdata) {
    this.writeFingerprints();
  },

  gone_secure_cb: function(opdata, context) {
    context = new Context(context);
    this.notifyObservers(context, "otr:msg-state");
    this.sendAlert(context, trans("context.gone_secure", context.username));
  },

  gone_insecure_cb: function(opdata, context) {
    // This isn't used. See: https://bugs.otr.im/issues/48
    this.log("gone_insecure_cb");
  },

  still_secure_cb: function(opdata, context, is_reply) {
    if (!is_reply) {
      context = new Context(context);
      this.notifyObservers(context, "otr:msg-state");
      this.sendAlert(context, trans("context.still_secure", context.username));
    }
  },

  max_message_size_cb: function(opdata, context) {
    context = new Context(context);
    switch(context.protocol) {
    case "irc":
      return 400;
    default:
      return 0;
    }
  },

  account_name_cb: function(opdata, account, protocol) {
    this.log("account_name_cb")
  },

  account_name_free_cb: function(opdata, account_name) {
    this.log("account_name_free_cb")
  },

  received_symkey_cb: function(opdata, context, use, usedata, usedatalen, symkey) {
    this.log("received_symkey_cb")
  },

  otr_error_message_cb: function(opdata, context, err_code) {
    this.log("otr_error_message_cb")
  },

  otr_error_message_free_cb: function(opdata, err_msg) {
    this.log("otr_error_message_free_cb")
  },

  resent_msg_prefix_cb: function(opdata, context) {
    this.log("resent_msg_prefix_cb")
  },

  resent_msg_prefix_free_cb: function(opdata, prefix) {
    this.log("resent_msg_prefix_free_cb")
  },

  handle_smp_event_cb: function(opdata, smp_event, context, progress_percent, question) {
    this.log("handle_smp_event_cb")
  },

  handle_msg_event_cb: function(opdata, msg_event, context, message, err) {
    context = new Context(context);
    switch(msg_event) {
    case libOTR.messageEvent.OTRL_MSGEVENT_RCVDMSG_NOT_IN_PRIVATE:
      if (!message.isNull())
        this.sendAlert(context, trans("msgevent.rcvd_unecrypted", message.readString()));
      break;
    case libOTR.messageEvent.OTRL_MSGEVENT_RCVDMSG_UNENCRYPTED:
      if (!message.isNull())
        this.sendAlert(context, trans("msgevent.rcvd_unecrypted", message.readString()));
      break;
    case libOTR.messageEvent.OTRL_MSGEVENT_LOG_HEARTBEAT_RCVD:
      this.log("Heartbeat received from " + context.username + ".");
      break;
    case libOTR.messageEvent.OTRL_MSGEVENT_LOG_HEARTBEAT_SENT:
      this.log("Heartbeat sent to " + context.username + ".");
      break;
    case libOTR.messageEvent.OTRL_MSGEVENT_ENCRYPTION_REQUIRED:
      this.log("Encryption required")
      break;
    case libOTR.messageEvent.OTRL_MSGEVENT_CONNECTION_ENDED:
      this.sendAlert(context, trans("msgevent.ended"));
      this.notifyObservers(context, "otr:msg-state");
      break;
    default:
      this.log("msg event: " + msg_event)
    }
  },

  create_instag_cb: function(opdata, accountname, protocol) {
    this.genInstag(accountname.readString(), protocol.readString())
  },

  convert_msg_cb: function(opdata, context, convert_type, dest, src) {
    this.log("convert_msg_cb")
  },

  convert_free_cb: function(opdata, context, dest) {
    this.log("convert_free_cb")
  },

  timer_control_cb: function(opdata, interval) {
    this.log("timer_control_cb")
  },

  // uiOps

  initUiOps: function() {
    let uiOps = new libOTR.OtrlMessageAppOps()

    let methods = [
      "policy",
      "create_privkey",
      "is_logged_in",
      "inject_message",
      "update_context_list",
      "new_fingerprint",
      "write_fingerprint",
      "gone_secure",
      "gone_insecure",
      "still_secure",
      "max_message_size",
      "account_name",
      "account_name_free",
      "received_symkey",
      "otr_error_message",
      "otr_error_message_free",
      "resent_msg_prefix",
      "resent_msg_prefix_free",
      "handle_smp_event",
      "handle_msg_event",
      "create_instag",
      "convert_msg",
      "convert_free",
      "timer_control"
    ];

    for (let i = 0; i < methods.length; i++) {
      let m = methods[i];
      // keep a pointer to this in memory to avoid crashing
      this[m + "_cb"] = libOTR[m + "_cb_t"](this[m + "_cb"].bind(this));
      uiOps[m] = this[m + "_cb"];
    }

    return uiOps;
  },

  sendAlert: function(context, msg) {
    let uiConv = this.getUIConvFromContext(context);
    if (uiConv)
      uiConv.systemMessage(msg);
    else
      Cu.reportError("Couldn't find conversation to inject.");
  },

  observe: function(aObject, aTopic, aMsg) {
    switch(aTopic) {
    case "sending-message":
      this.onSend(aObject);
      break;
    case "received-message":
      this.onReceive(aObject);
      break;
    case "new-ui-conversation":
      let conv = aObject.target;
      if (conv.isChat)
        return;
      this._convos.set(conv.id, aObject);
      aObject.addObserver(this);
      // FIXME: this belongs somewhere else
      let account = conv.account.normalizedName;
      let protocol = conv.account.protocol.normalizedName;
      if (this.privateKeyFingerprint(account, protocol) === null)
        this.generatePrivateKey(account, protocol);
      break;
    }
  },

  removeConversation: function(uiConv) {
    uiConv.removeObserver(this);
    this._convos.delete(uiConv.target.id);
    this.clearMsgs(uiConv.target.id);
  },

  onSend: function(om) {
    if (om.cancelled)
      return;

    // FIXME: om.conversation should be a uiConv.
    let uiConv = this._convos.get(om.conversation.id);
    if (!uiConv) {
      om.cancelled = true;
      Cu.reportError(new Error("Sending to an unknown conversation."));
      return;
    }
    let conv = uiConv.target;

    this.log("pre sending: " + om.message)

    let newMessage = new ctypes.char.ptr();

    let err = libOTR.otrl_message_sending(
      this.userstate,
      this.uiOps.address(),
      null,
      conv.account.normalizedName,
      conv.account.protocol.normalizedName,
      conv.normalizedName,
      libOTR.OTRL_INSTAG_BEST,
      om.message,
      null,
      newMessage.address(),
      libOTR.fragPolicy.OTRL_FRAGMENT_SEND_ALL_BUT_LAST,
      null,
      null,
      null
    );

    let msg = om.message;

    if (err) {
      om.cancelled = true;
      Cu.reportError(new Error("OTR returned code: " + err));
    } else if (!newMessage.isNull()) {
      msg = newMessage.readString();
      // https://bugs.otr.im/issues/52
      if (!msg) {
        om.cancelled = true;
      }
    }

    if (!om.cancelled) {
      this.bufferMsg(conv.id, om.message, msg);
      om.message = msg;
    }

    this.log("post sending (" + !om.cancelled + "): " + om.message);
    libOTR.otrl_message_free(newMessage);
  },

  onReceive: function(im) {
    if (im.cancelled || im.system)
      return;

    if (im.outgoing) {
      this.log("outgoing message to display: " + im.displayMessage)
      this.pluckMsg(im);
      return;
    }

    let conv = im.conversation;
    let newMessage = new ctypes.char.ptr();
    let tlvs = new libOTR.OtrlTLV.ptr();

    this.log("pre receiving: " + im.displayMessage)

    let res = libOTR.otrl_message_receiving(
      this.userstate,
      this.uiOps.address(),
      null,
      conv.account.normalizedName,
      conv.account.protocol.normalizedName,
      conv.normalizedName,
      im.displayMessage,
      newMessage.address(),
      tlvs.address(),
      null,
      null,
      null
    );

    if (!newMessage.isNull()) {
      im.displayMessage = newMessage.readString();
    }

    // search tlvs for a disconnect msg
    // https://bugs.otr.im/issues/54
    let tlv = libOTR.otrl_tlv_find(tlvs, libOTR.tlvs.OTRL_TLV_DISCONNECTED);
    if (!tlv.isNull()) {
      let context = this.getContext(conv);
      this.sendAlert(context, trans("msgevent.ended"));
      this.notifyObservers(context, "otr:msg-state");
    }

    if (res) {
      this.log("error (" + res + ") ignoring: " + im.displayMessage)
      im.cancelled = true;  // ignore
    } else {
      this.log("post receiving: " + im.displayMessage)
    }

    libOTR.otrl_message_free(newMessage);
  },

  // observer interface

  addObserver: function(aObserver) {
    if (this._observers.indexOf(aObserver) == -1)
      this._observers.push(aObserver);
  },

  removeObserver: function(aObserver) {
    this._observers = this._observers.filter(function(o) o !== aObserver);
  },

  notifyObservers: function(aSubject, aTopic, aData) {
    for each (let observer in this._observers) {
      observer.observe(aSubject, aTopic, aData);
    }
  },

  // buffer messages

  clearMsgs: function(convId) {
    this._buffer = this._buffer.filter((msg) => msg.convId !== convId);
  },

  bufferMsg: function(convId, display, sent) {
    this._buffer.push({
      convId: convId,
      display: display,
      sent: sent
    });
  },

  // set a timer for unplucked msgs
  pluckMsg: function(im) {
    let buf = this._buffer;
    for (let i = 0; i < buf.length; i++) {
      let b = buf[i];
      if (b.convId === im.conversation.id && b.sent === im.displayMessage) {
        im.displayMessage = b.display;
        buf.splice(i, 1);
        this.log("displaying: " + b.display)
        return;
      }
    }
    // don't display if it wasn't buffered
    im.cancelled = true;
    this.log("not displaying: " + im.displayMessage)
  }

};