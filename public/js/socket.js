// Socket.io client integration for ChatQ with Token Authentication
class ChatSocket {
  constructor() {
    this.socket = null;
    this.currentUser = null;
    this.token = null;
    this.activeTarget = null;
  }

  init(user, token) {
    this.currentUser = user;
    this.token = token;

    if (this.socket) {
      this.socket.disconnect();
    }

    // Connect with JWT/Clerk token in auth payload
    this.socket = io({
      auth: {
        token: this.token
      },
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000
    });

    this.socket.on('connect', () => {
      console.log('[Socket] Connected & Authenticated successfully.');
    });

    this.socket.on('connect_error', (err) => {
      console.error('[Socket Auth Error]:', err.message);
      if (err.message && (err.message.includes('Authentication') || err.message.includes('token'))) {
        alert('Session expired or invalid. Please sign in again.');
        window.ui.handleLogout();
      }
    });

    this.socket.on('user:registered', (registeredUser) => {
      this.currentUser = registeredUser;
      window.ui.updateCurrentUserBadge(registeredUser);
    });

    this.socket.on('contacts:data', ({ contacts, requests }) => {
      window.ui.handleContactsData(contacts, requests);
    });

    this.socket.on('contact:request:received', ({ from, request }) => {
      window.sounds.playMessagePing();
      window.ui.showToast(`New contact request from ${from.username}!`);
      this.socket.emit('contacts:refresh');
    });

    this.socket.on('contact:request:resolved', ({ action, user }) => {
      window.sounds.playMessagePing();
      window.ui.showToast(
        action === 'accept'
          ? `${user.username} accepted your contact request! You can now chat and call.`
          : `${user.username} declined your contact request.`
      );
      this.socket.emit('contacts:refresh');
    });

    this.socket.on('chat:error', ({ message }) => {
      alert(message);
    });

    this.socket.on('chat:message', (message) => {
      window.ui.handleIncomingMessage(message);
      if (message.senderId !== this.currentUser?.id) {
        window.sounds.playMessagePing();
      }
    });

    this.socket.on('chat:history', ({ roomId, messages, unauthorized, message }) => {
      if (unauthorized) {
        window.ui.renderUnauthorizedChat(message);
      } else {
        window.ui.renderChatHistory(messages);
      }
    });

    this.socket.on('chat:typing', ({ userId, username, isTyping }) => {
      window.ui.setTypingIndicator(username, isTyping);
    });

    // ================= WebRTC Events =================
    this.socket.on('call:incoming', ({ caller, type }) => {
      window.webrtc.handleIncomingCall(caller, type);
    });

    this.socket.on('call:accepted', ({ callee, type }) => {
      window.webrtc.onCallAccepted(callee, type);
    });

    this.socket.on('call:rejected', ({ reason }) => {
      alert(`Call was declined: ${reason}`);
      window.webrtc.endCall(false);
    });

    this.socket.on('call:ended', () => {
      alert('The other party has ended the call.');
      window.webrtc.endCall(false);
    });

    this.socket.on('call:busy', () => {
      alert('User is currently busy on another call.');
      window.webrtc.endCall(false);
    });

    this.socket.on('call:failed', ({ reason }) => {
      alert(`Call failed: ${reason}`);
      window.webrtc.endCall(false);
    });

    this.socket.on('webrtc:offer', ({ fromUserId, offer }) => {
      window.webrtc.handleOffer(fromUserId, offer);
    });

    this.socket.on('webrtc:answer', ({ answer }) => {
      window.webrtc.handleAnswer(answer);
    });

    this.socket.on('webrtc:ice-candidate', ({ candidate }) => {
      window.webrtc.handleIceCandidate(candidate);
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.currentUser = null;
    this.token = null;
  }

  emit(event, data) {
    if (this.socket) {
      this.socket.emit(event, data);
    }
  }

  sendMessage(text, attachment = null) {
    if (!text && !attachment) return;

    this.socket.emit('chat:message', {
      targetUserId: this.activeTarget ? this.activeTarget.id : null,
      roomId: this.activeTarget ? null : 'general',
      content: text,
      attachment
    });
  }

  sendTyping(isTyping) {
    if (!this.activeTarget) return;
    this.socket.emit('chat:typing', {
      targetUserId: this.activeTarget.id,
      isTyping
    });
  }

  selectTarget(userOrNull) {
    this.activeTarget = userOrNull;
    window.ui.switchActiveChat(userOrNull);

    // Request history
    this.socket.emit('chat:history', {
      targetUserId: userOrNull ? userOrNull.id : null,
      roomId: userOrNull ? null : 'general'
    });
  }
}

window.chatSocket = new ChatSocket();
