// Main Application Controller for ChatQ with Secure Auth & Clerk Support
class ChatAppUI {
  constructor() {
    this.selectedAvatar = 'https://api.dicebear.com/7.x/bottts/svg?seed=Alex';
    this.pendingAttachment = null;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;

    this.allUsers = [];
    this.contacts = [];
    this.requests = { incoming: [], outgoing: [] };
    this.unreadCounts = new Map(); // targetKey -> count ('general' or userId)
    this.activeTarget = null;
    this.currentUser = null;
    this.token = localStorage.getItem('chatq_token') || null;

    this.authMode = 'login'; // 'login' or 'register'
    this.clerkConfig = null;

    this.initDOM();
    this.checkAuthConfig();
    this.checkExistingSession();
  }

  async checkAuthConfig() {
    try {
      const res = await fetch('/api/auth/config');
      this.clerkConfig = await res.json();

      if (this.clerkConfig.clerkEnabled && this.clerkConfig.clerkPublishableKey) {
        this.loadClerkSDK(this.clerkConfig.clerkPublishableKey);
      }
    } catch (err) {
      console.warn('Failed to fetch auth config:', err);
    }
  }

  getClerkFrontendApi(publishableKey) {
    try {
      const base64 = publishableKey.replace(/^pk_(test|live)_/, '');
      return atob(base64).replace(/\$$/, '');
    } catch (e) {
      return '';
    }
  }

  loadClerkSDK(publishableKey) {
    const domain = this.getClerkFrontendApi(publishableKey);
    const scriptUrl = domain 
      ? `https://${domain}/npm/@clerk/clerk-js@latest/dist/clerk.browser.js`
      : 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js';

    const script = document.createElement('script');
    script.setAttribute('data-clerk-publishable-key', publishableKey);
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.src = scriptUrl;
    script.addEventListener('load', async () => {
      if (window.Clerk) {
        await window.Clerk.load();
        console.log('[Clerk] Official Frontend SDK loaded and ready.');

        window.Clerk.addListener(({ user }) => {
          if (user) {
            console.log('[Clerk] Session detected for:', user.id);
            this.handleClerkSuccess(user);
            if (window.Clerk.closeSignIn) window.Clerk.closeSignIn();
            if (window.Clerk.closeSignUp) window.Clerk.closeSignUp();
          }
        });

        // If Clerk already has an active session
        if (window.Clerk.user) {
          this.handleClerkSuccess(window.Clerk.user);
        }
      }
    });
    document.head.appendChild(script);
  }

  async handleClerkSuccess(clerkUser) {
    try {
      const email = clerkUser.primaryEmailAddress ? clerkUser.primaryEmailAddress.emailAddress : '';
      const username = clerkUser.username || clerkUser.firstName || 'User';
      const avatar = clerkUser.imageUrl;

      const res = await fetch('/api/auth/clerk-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clerkId: clerkUser.id,
          email,
          username,
          avatar
        })
      });

      const data = await res.json();
      if (data.success) {
        this.setSession(data.user, data.token);
      }
    } catch (err) {
      console.error('Clerk sync error:', err);
    }
  }

  async checkExistingSession() {
    if (!this.token) {
      this.showLoginModal();
      return;
    }

    try {
      const res = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      const data = await res.json();
      if (data.success && data.user) {
        this.setSession(data.user, this.token);
      } else {
        this.clearSession();
        this.showLoginModal();
      }
    } catch (err) {
      this.clearSession();
      this.showLoginModal();
    }
  }

  initDOM() {
    // 1. Auth Tabs
    const tabLogin = document.getElementById('tab-login');
    const tabRegister = document.getElementById('tab-register');
    const groupUsername = document.getElementById('group-username');
    const registerAvatarGroup = document.getElementById('register-avatar-group');
    const submitBtnText = document.getElementById('submit-btn-text');

    tabLogin.addEventListener('click', () => {
      this.authMode = 'login';
      tabLogin.classList.add('active');
      tabRegister.classList.remove('active');
      groupUsername.style.display = 'none';
      registerAvatarGroup.style.display = 'none';
      submitBtnText.textContent = 'Sign In';
      this.clearAuthError();
    });

    tabRegister.addEventListener('click', () => {
      this.authMode = 'register';
      tabRegister.classList.add('active');
      tabLogin.classList.remove('active');
      groupUsername.style.display = 'block';
      registerAvatarGroup.style.display = 'block';
      submitBtnText.textContent = 'Create Account';
      this.clearAuthError();
    });

    // 2. Avatar Selection
    const avatarEls = document.querySelectorAll('.avatar-option');
    avatarEls.forEach(el => {
      el.addEventListener('click', () => {
        avatarEls.forEach(a => a.classList.remove('selected'));
        el.classList.add('selected');
        this.selectedAvatar = el.dataset.avatar;
      });
    });

    // 3. Demo Quick Logins (1-Click)
    document.getElementById('demo-alice').addEventListener('click', () => {
      this.doLogin('alice@chatq.io', 'Password123!');
    });
    document.getElementById('demo-bob').addEventListener('click', () => {
      this.doLogin('bob@chatq.io', 'Password123!');
    });
    document.getElementById('demo-charlie').addEventListener('click', () => {
      this.doLogin('charlie@chatq.io', 'Password123!');
    });

    // 4. Clerk Auth Button Trigger
    document.getElementById('btn-clerk-auth').addEventListener('click', () => {
      if (this.clerkConfig && this.clerkConfig.clerkEnabled && window.Clerk) {
        try {
          if (typeof window.Clerk.openSignIn === 'function') {
            window.Clerk.openSignIn();
          } else if (typeof window.Clerk.redirectToSignIn === 'function') {
            window.Clerk.redirectToSignIn({ returnBackUrl: window.location.href });
          }
        } catch (err) {
          console.warn('Modal open failed, falling back to redirect:', err);
          if (typeof window.Clerk.redirectToSignIn === 'function') {
            window.Clerk.redirectToSignIn({ returnBackUrl: window.location.href });
          }
        }
      } else {
        alert(
          'Clerk integration is enabled in code! To connect to your real Clerk dashboard:\n\n' +
          '1. Set CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY in your .env file.\n' +
          '2. Restart the server.\n\n' +
          'In the meantime, you can instantly use the built-in Secure Auth or 1-Click Demo accounts below!'
        );
      }
    });

    // 5. Auth Form Submission (Register / Login)
    const authForm = document.getElementById('auth-form');
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('email-input').value.trim();
      const password = document.getElementById('password-input').value;
      const username = document.getElementById('username-input').value.trim();

      if (this.authMode === 'login') {
        await this.doLogin(email, password);
      } else {
        await this.doRegister(username, email, password, this.selectedAvatar);
      }
    });

    // 6. Sign Out Button (using event delegation)
    document.addEventListener('click', (e) => {
      if (e.target.closest('#btn-logout')) {
        this.handleLogout();
      }
    });

    // 7. Chat Input & Send
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('btn-send');

    const handleSendMessage = async () => {
      const text = chatInput.value.trim();
      let attachment = null;

      if (this.pendingAttachment) {
        attachment = await this.uploadFile(this.pendingAttachment);
        this.clearAttachmentPreview();
      }

      if (text || attachment) {
        window.chatSocket.sendMessage(text, attachment);
        chatInput.value = '';
        window.chatSocket.sendTyping(false);
      }
    };

    sendBtn.addEventListener('click', handleSendMessage);
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
      }
    });

    let typingTimer = null;
    chatInput.addEventListener('input', () => {
      window.chatSocket.sendTyping(true);
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        window.chatSocket.sendTyping(false);
      }, 1500);
    });

    // 8. Attachments
    const fileInput = document.getElementById('file-input');
    const btnAttach = document.getElementById('btn-attach');
    btnAttach.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        this.setAttachmentPreview(e.target.files[0]);
      }
    });

    document.getElementById('btn-remove-attachment').addEventListener('click', () => {
      this.clearAttachmentPreview();
    });

    // 9. Voice Note Recording
    const btnRecord = document.getElementById('btn-record');
    btnRecord.addEventListener('click', () => this.toggleVoiceRecording());

    // 10. General Channel click
    document.getElementById('channel-general').addEventListener('click', () => {
      this.setActiveChannel();
    });

    // 11. Header Call Buttons (Enforce Contact Authorization)
    document.getElementById('btn-call-audio').addEventListener('click', () => {
      if (!this.activeTarget) {
        alert('Please select an authorized contact to start an audio call.');
        return;
      }
      if (!this.isAcceptedContact(this.activeTarget.id)) {
        alert('Interaction blocked: You must be accepted contacts before starting an audio call.');
        return;
      }
      window.webrtc.startCall(this.activeTarget, 'audio');
    });

    document.getElementById('btn-call-video').addEventListener('click', () => {
      if (!this.activeTarget) {
        alert('Please select an authorized contact to start a video call.');
        return;
      }
      if (!this.isAcceptedContact(this.activeTarget.id)) {
        alert('Interaction blocked: You must be accepted contacts before starting a video call.');
        return;
      }
      window.webrtc.startCall(this.activeTarget, 'video');
    });

    // 12. Incoming Call Modal Actions
    document.getElementById('btn-accept-call').addEventListener('click', () => {
      window.webrtc.acceptCall();
    });
    document.getElementById('btn-decline-call').addEventListener('click', () => {
      window.webrtc.rejectCall('Call declined by user');
    });

    // 13. Active Call Controls
    document.getElementById('btn-mute').addEventListener('click', () => {
      window.webrtc.toggleMute();
    });
    document.getElementById('btn-video-toggle').addEventListener('click', () => {
      window.webrtc.toggleVideo();
    });
    document.getElementById('btn-screen-share').addEventListener('click', () => {
      window.webrtc.toggleScreenShare();
    });
    document.getElementById('btn-end-call').addEventListener('click', () => {
      window.webrtc.endCall();
    });

    // 14. Lightbox Modal
    const lightboxModal = document.getElementById('lightbox-modal');
    const lightboxClose = document.getElementById('lightbox-close');
    if (lightboxClose && lightboxModal) {
      lightboxClose.addEventListener('click', () => {
        lightboxModal.classList.add('hidden');
      });
      lightboxModal.addEventListener('click', (e) => {
        if (e.target === lightboxModal) lightboxModal.classList.add('hidden');
      });
    }

    // 15. Sidebar contacts search filter & registered user discovery
    const searchInput = document.getElementById('search-users');
    let sidebarSearchTimer = null;
    searchInput.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      const filtered = this.contacts.filter(u => u.username.toLowerCase().includes(q) || (u.email && u.email.toLowerCase().includes(q)));
      this.renderContactsList(filtered);

      clearTimeout(sidebarSearchTimer);
      if (q.length > 0) {
        sidebarSearchTimer = setTimeout(() => {
          this.searchAndRenderSidebarGlobal(q);
        }, 300);
      } else {
        const discoverSection = document.getElementById('sidebar-discover-section');
        if (discoverSection) discoverSection.style.display = 'none';
      }
    });

    // 16. Contact Requests Toggle Bar
    document.getElementById('requests-toggle-bar').addEventListener('click', () => {
      const container = document.getElementById('pending-requests-container');
      container.classList.toggle('active');
    });

    // 17. Add Contact Modal Controls
    const modalAddContact = document.getElementById('modal-add-contact');
    const inputSearchUsers = document.getElementById('input-search-users');
    const btnSubmitUserSearch = document.getElementById('btn-submit-user-search');

    document.getElementById('btn-open-add-contact').addEventListener('click', () => {
      modalAddContact.classList.remove('hidden');
      if (inputSearchUsers) {
        inputSearchUsers.value = '';
        inputSearchUsers.focus();
      }
      this.searchAndRenderUsers('');
    });

    document.getElementById('btn-close-add-modal').addEventListener('click', () => {
      modalAddContact.classList.add('hidden');
    });

    modalAddContact.addEventListener('click', (e) => {
      if (e.target === modalAddContact) modalAddContact.classList.add('hidden');
    });

    let searchContactTimer = null;
    if (inputSearchUsers) {
      inputSearchUsers.addEventListener('input', (e) => {
        clearTimeout(searchContactTimer);
        searchContactTimer = setTimeout(() => {
          this.searchAndRenderUsers(e.target.value);
        }, 200);
      });

      inputSearchUsers.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          clearTimeout(searchContactTimer);
          this.searchAndRenderUsers(inputSearchUsers.value);
        }
      });
    }

    if (btnSubmitUserSearch) {
      btnSubmitUserSearch.addEventListener('click', (e) => {
        e.preventDefault();
        clearTimeout(searchContactTimer);
        this.searchAndRenderUsers(inputSearchUsers ? inputSearchUsers.value : '');
      });
    }

    // 18. Banner Add Contact Trigger
    document.getElementById('btn-banner-add-contact').addEventListener('click', async () => {
      if (this.activeTarget) {
        await this.sendContactRequest(this.activeTarget.id);
      }
    });
  }

  // Authentication Actions
  async doLogin(emailOrUsername, password) {
    this.clearAuthError();
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername, password })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to sign in');
      }
      this.setSession(data.user, data.token);
    } catch (err) {
      this.showAuthError(err.message);
    }
  }

  async doRegister(username, email, password, avatar) {
    this.clearAuthError();
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password, avatar })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to create account');
      }
      this.setSession(data.user, data.token);
    } catch (err) {
      this.showAuthError(err.message);
    }
  }

  setSession(user, token) {
    this.currentUser = user;
    this.token = token;
    localStorage.setItem('chatq_token', token);

    this.hideLoginModal();
    this.updateCurrentUserBadge(user);
    window.chatSocket.init(user, token);
  }

  clearSession() {
    this.currentUser = null;
    this.token = null;
    localStorage.removeItem('chatq_token');
  }

  handleLogout() {
    this.clearSession();
    window.chatSocket.disconnect();
    if (window.Clerk && window.Clerk.signOut) {
      window.Clerk.signOut();
    }
    this.showLoginModal();
  }

  showLoginModal() {
    document.getElementById('login-modal').classList.remove('hidden');
  }

  hideLoginModal() {
    document.getElementById('login-modal').classList.add('hidden');
  }

  showAuthError(msg) {
    const el = document.getElementById('auth-error-msg');
    el.textContent = msg;
    el.classList.add('active');
  }

  clearAuthError() {
    const el = document.getElementById('auth-error-msg');
    el.textContent = '';
    el.classList.remove('active');
  }

  // Upload file with Authorization header
  async uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`
        },
        body: formData
      });
      const data = await res.json();
      if (data.success) {
        let type = 'file';
        if (data.file.mimetype.startsWith('image/')) type = 'image';
        else if (data.file.mimetype.startsWith('video/')) type = 'video';
        else if (data.file.mimetype.startsWith('audio/')) type = 'audio';

        return {
          type,
          url: data.file.url,
          filename: data.file.filename,
          size: data.file.size,
          mimetype: data.file.mimetype
        };
      } else {
        alert(data.error || 'Upload failed');
      }
    } catch (err) {
      console.error('File upload error:', err);
      alert('Failed to upload file');
    }
    return null;
  }

  setAttachmentPreview(file) {
    this.pendingAttachment = file;
    const previewBar = document.getElementById('attachment-preview-bar');
    const thumb = document.getElementById('preview-thumbnail');
    const nameEl = document.getElementById('preview-name');
    const sizeEl = document.getElementById('preview-size');

    previewBar.classList.add('active');
    nameEl.textContent = file.name;
    sizeEl.textContent = this.formatFileSize(file.size);

    if (file.type.startsWith('image/')) {
      thumb.src = URL.createObjectURL(file);
      thumb.style.display = 'block';
    } else {
      thumb.style.display = 'none';
    }
  }

  clearAttachmentPreview() {
    this.pendingAttachment = null;
    document.getElementById('attachment-preview-bar').classList.remove('active');
    document.getElementById('file-input').value = '';
  }

  async toggleVoiceRecording() {
    const btnRecord = document.getElementById('btn-record');

    if (!this.isRecording) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.mediaRecorder = new MediaRecorder(stream);
        this.audioChunks = [];

        this.mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) this.audioChunks.push(e.data);
        };

        this.mediaRecorder.onstop = async () => {
          const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
          const audioFile = new File([audioBlob], `voice-note-${Date.now()}.webm`, { type: 'audio/webm' });
          
          stream.getTracks().forEach(t => t.stop());

          const attachment = await this.uploadFile(audioFile);
          if (attachment) {
            attachment.type = 'audio_note';
            window.chatSocket.sendMessage('', attachment);
          }
        };

        this.mediaRecorder.start();
        this.isRecording = true;
        btnRecord.classList.add('recording');
        btnRecord.title = 'Click to stop recording & send voice note';
      } catch (err) {
        console.error('Audio recording failed:', err);
        alert('Microphone access is required to record voice notes.');
      }
    } else {
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
      }
      this.isRecording = false;
      btnRecord.classList.remove('recording');
      btnRecord.title = 'Record voice note';
    }
  }

  updateCurrentUserBadge(user) {
    document.getElementById('my-avatar-img').src = user.avatar;
    document.getElementById('my-username').textContent = user.username;
    document.getElementById('my-email').textContent = user.email || 'Online';
  }

  handleContactsData(contacts, requests) {
    this.contacts = contacts || [];
    this.requests = requests || { incoming: [], outgoing: [] };

    this.renderContactsList(this.contacts);
    this.renderPendingRequests(this.requests.incoming);

    const badge = document.getElementById('requests-badge');
    const toggleBar = document.getElementById('requests-toggle-bar');
    const incomingCount = this.requests.incoming.length;

    badge.textContent = incomingCount;
    if (incomingCount > 0) {
      toggleBar.style.display = 'flex';
      // Auto expand so recipient immediately sees the pending request and accept button!
      document.getElementById('pending-requests-container').classList.add('active');
    } else {
      toggleBar.style.display = 'none';
      document.getElementById('pending-requests-container').classList.remove('active');
    }

    // Refresh modal search if currently visible
    const modal = document.getElementById('modal-add-contact');
    if (modal && !modal.classList.contains('hidden')) {
      const input = document.getElementById('input-search-users');
      this.searchAndRenderUsers(input ? input.value : '');
    }

    // Refresh sidebar search if user currently has text in sidebar search
    const sidebarSearch = document.getElementById('search-users');
    if (sidebarSearch && sidebarSearch.value.trim().length > 0) {
      this.searchAndRenderSidebarGlobal(sidebarSearch.value.trim());
    }

    if (this.activeTarget) {
      this.updateChatAuthorization();
    }
  }

  renderContactsList(contacts) {
    const container = document.getElementById('direct-messages-list');
    container.innerHTML = '';

    if (!contacts || contacts.length === 0) {
      container.innerHTML = `
        <div style="padding: 0.85rem 1rem; color: var(--text-muted); font-size: 0.8rem; text-align: center;">
          No authorized contacts yet.<br/>
          Click <strong>+ Add</strong> above to send a request!
        </div>
      `;
      return;
    }

    contacts.forEach(user => {
      const item = document.createElement('div');
      item.className = 'user-item' + (this.activeTarget?.id === user.id ? ' active' : '');
      item.setAttribute('data-user-id', user.id);

      const unreadCount = this.unreadCounts.get(user.id) || 0;
      const displayCount = unreadCount > 99 ? '99+' : unreadCount;

      item.innerHTML = `
        <div class="avatar-wrap">
          <img src="${user.avatar}" alt="${user.username}" />
          <span class="status-dot ${user.status}"></span>
          <span class="avatar-unread-dot ${unreadCount > 0 ? '' : 'hidden'}"></span>
        </div>
        <div class="user-item-info">
          <div class="user-item-name">${user.username}</div>
          <div class="user-item-desc">${user.status === 'in-call' ? '📞 In Call' : (user.status === 'online' ? 'Online' : 'Offline')}</div>
        </div>
        <span class="unread-badge ${unreadCount > 0 ? '' : 'hidden'}">${displayCount}</span>
      `;

      item.addEventListener('click', () => {
        this.clearUnread(user.id);
        this.setActiveDirectChat(user);
      });

      container.appendChild(item);
    });
  }

  renderPendingRequests(incoming) {
    const container = document.getElementById('pending-requests-container');
    container.innerHTML = '';

    if (!incoming || incoming.length === 0) {
      container.innerHTML = `<div style="font-size: 0.75rem; color: var(--text-muted); padding: 4px;">No incoming requests.</div>`;
      return;
    }

    incoming.forEach(item => {
      const card = document.createElement('div');
      card.className = 'request-card';
      card.innerHTML = `
        <div class="request-card-info">
          <img src="${item.user.avatar}" alt="${item.user.username}" />
          <div class="request-card-text">
            <div class="request-card-name">${item.user.username}</div>
            <div class="request-card-sub">${item.user.email || 'Sent you a request'}</div>
          </div>
        </div>
        <div class="request-card-actions">
          <button class="btn-req-accept" title="Accept Request">✓</button>
          <button class="btn-req-reject" title="Decline Request">&times;</button>
        </div>
      `;

      card.querySelector('.btn-req-accept').addEventListener('click', () => {
        this.respondContactRequest(item.requestId, 'accept');
      });
      card.querySelector('.btn-req-reject').addEventListener('click', () => {
        this.respondContactRequest(item.requestId, 'reject');
      });

      container.appendChild(card);
    });
  }

  isAcceptedContact(userId) {
    if (!userId) return false;
    return this.contacts.some(c => c.id === userId);
  }

  setActiveChannel() {
    this.clearUnread('general');
    this.activeTarget = null;
    document.getElementById('channel-general').classList.add('active');
    document.querySelectorAll('.user-item').forEach(el => el.classList.remove('active'));

    document.getElementById('chat-target-avatar').src = 'https://api.dicebear.com/7.x/identicon/svg?seed=General';
    document.getElementById('chat-target-name').textContent = '# General Channel';
    document.getElementById('chat-target-status').textContent = 'Public group channel';

    document.getElementById('btn-call-audio').style.display = 'none';
    document.getElementById('btn-call-video').style.display = 'none';

    document.getElementById('blocked-interaction-banner').classList.add('hidden');
    document.getElementById('chat-input').disabled = false;
    document.getElementById('btn-send').disabled = false;
    document.getElementById('btn-attach').disabled = false;
    document.getElementById('btn-record').disabled = false;

    window.chatSocket.selectTarget(null);
  }

  setActiveDirectChat(user) {
    this.clearUnread(user.id);
    this.activeTarget = user;
    document.getElementById('channel-general').classList.remove('active');
    document.querySelectorAll('.user-item').forEach(el => {
      el.classList.toggle('active', el.querySelector('.user-item-name')?.textContent === user.username);
    });

    document.getElementById('chat-target-avatar').src = user.avatar;
    document.getElementById('chat-target-name').textContent = user.username;
    document.getElementById('chat-target-status').textContent = user.status === 'in-call' ? 'In Call' : (user.status === 'online' ? 'Online' : 'Offline');

    this.updateChatAuthorization();

    window.chatSocket.selectTarget(user);
  }

  updateChatAuthorization() {
    if (!this.activeTarget) return;

    const isFriend = this.isAcceptedContact(this.activeTarget.id);
    const banner = document.getElementById('blocked-interaction-banner');
    const bannerText = document.getElementById('blocked-banner-text');
    const bannerBtn = document.getElementById('btn-banner-add-contact');
    const callAudio = document.getElementById('btn-call-audio');
    const callVideo = document.getElementById('btn-call-video');
    const chatInput = document.getElementById('chat-input');
    const btnSend = document.getElementById('btn-send');
    const btnAttach = document.getElementById('btn-attach');
    const btnRecord = document.getElementById('btn-record');

    if (isFriend) {
      banner.classList.add('hidden');
      callAudio.style.display = 'flex';
      callVideo.style.display = 'flex';
      chatInput.disabled = false;
      btnSend.disabled = false;
      btnAttach.disabled = false;
      btnRecord.disabled = false;
      chatInput.placeholder = 'Type a message or share media...';
    } else {
      banner.classList.remove('hidden');
      callAudio.style.display = 'none';
      callVideo.style.display = 'none';
      chatInput.disabled = true;
      btnSend.disabled = true;
      btnAttach.disabled = true;
      btnRecord.disabled = true;
      chatInput.placeholder = 'Contact request must be accepted to message this user.';

      const isPendingOutgoing = this.requests.outgoing.some(r => r.user.id === this.activeTarget.id);
      const isPendingIncoming = this.requests.incoming.some(r => r.user.id === this.activeTarget.id);

      if (isPendingOutgoing) {
        bannerText.textContent = `⏳ Contact request sent to ${this.activeTarget.username}. Waiting for approval.`;
        bannerBtn.style.display = 'none';
      } else if (isPendingIncoming) {
        bannerText.textContent = `📬 ${this.activeTarget.username} sent you a contact request! Accept it in the sidebar to interact.`;
        bannerBtn.style.display = 'none';
      } else {
        bannerText.textContent = `⚠️ You and ${this.activeTarget.username} are not connected contacts. Send a request to interact.`;
        bannerBtn.style.display = 'inline-flex';
        bannerBtn.textContent = '➕ Send Contact Request';
      }
    }
  }

  renderUnauthorizedChat(message) {
    const messagesFeed = document.getElementById('messages-feed');
    messagesFeed.innerHTML = `
      <div class="system-message" style="color: var(--danger); border-color: rgba(239, 68, 68, 0.4);">
        🔒 ${message || 'You must be accepted contacts to interact with this user.'}
      </div>
    `;
    this.updateChatAuthorization();
  }

  async searchAndRenderUsers(query) {
    const list = document.getElementById('search-results-list');
    list.innerHTML = `<div style="text-align: center; color: var(--text-muted); font-size: 0.8rem; padding: 1rem;">Searching...</div>`;

    try {
      const q = (query || '').trim();
      const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(q)}`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      const data = await res.json();
      if (!data.success || !data.results || data.results.length === 0) {
        const emptyMsg = q ? `No registered users found matching "${this.escapeHtml(q)}".` : 'No other registered users found.';
        list.innerHTML = `<div style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 1.5rem;">${emptyMsg}</div>`;
        return;
      }

      list.innerHTML = '';
      data.results.forEach(user => {
        const item = document.createElement('div');
        item.className = 'search-result-item';

        let btnHtml = '';
        if (user.relationship === 'accepted') {
          btnHtml = `<button class="btn-send-req accepted" disabled>✓ Connected</button>`;
        } else if (user.relationship === 'pending_sent') {
          btnHtml = `<button class="btn-send-req disabled" disabled>⏳ Pending...</button>`;
        } else if (user.relationship === 'pending_received') {
          btnHtml = `<button class="btn-send-req btn-action-accept" style="background: var(--success); color: white; cursor: pointer;">✓ Accept</button>`;
        } else {
          btnHtml = `<button class="btn-send-req btn-action-add" style="background: var(--primary); color: white; cursor: pointer;">➕ Add Contact</button>`;
        }

        item.innerHTML = `
          <div class="search-user-info">
            <img src="${user.avatar}" alt="${user.username}" />
            <div class="search-user-text">
              <div class="search-user-name">${user.username}</div>
              <div class="search-user-email">${user.email}</div>
            </div>
          </div>
          <div>${btnHtml}</div>
        `;

        const acceptBtn = item.querySelector('.btn-action-accept');
        if (acceptBtn) {
          acceptBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            acceptBtn.disabled = true;
            acceptBtn.textContent = 'Accepting...';
            await this.respondContactRequest(user.requestId, 'accept');
          });
        }

        const addBtn = item.querySelector('.btn-action-add');
        if (addBtn) {
          addBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            addBtn.disabled = true;
            addBtn.textContent = 'Sending...';
            await this.sendContactRequest(user.id);
          });
        }

        list.appendChild(item);
      });
    } catch (err) {
      console.error('Failed to search users:', err);
      list.innerHTML = `<div style="color: var(--danger); font-size: 0.8rem; padding: 1rem;">Error searching users.</div>`;
    }
  }

  async searchAndRenderSidebarGlobal(query) {
    const discoverSection = document.getElementById('sidebar-discover-section');
    const discoverList = document.getElementById('sidebar-discover-list');
    if (!discoverSection || !discoverList) return;

    const q = (query || '').trim();
    if (!q) {
      discoverSection.style.display = 'none';
      return;
    }

    discoverSection.style.display = 'block';
    discoverList.innerHTML = `<div style="font-size: 0.75rem; color: var(--text-muted); padding: 0.4rem;">Searching users...</div>`;

    try {
      const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(q)}`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      const data = await res.json();
      if (!data.success || !data.results || data.results.length === 0) {
        discoverList.innerHTML = `<div style="font-size: 0.75rem; color: var(--text-muted); padding: 0.4rem;">No other users found matching "${this.escapeHtml(q)}".</div>`;
        return;
      }

      // Filter out users who are already in this.contacts (they are already shown above)
      const nonContacts = data.results.filter(u => !this.contacts.some(c => c.id === u.id));

      if (nonContacts.length === 0) {
        discoverList.innerHTML = `<div style="font-size: 0.75rem; color: var(--text-muted); padding: 0.4rem;">All matching users are already in your contacts!</div>`;
        return;
      }

      discoverList.innerHTML = '';
      nonContacts.forEach(user => {
        const item = document.createElement('div');
        item.className = 'user-item';
        item.style.cursor = 'default';
        item.style.padding = '0.4rem 0.6rem';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.justifyContent = 'space-between';

        let actionHtml = '';
        if (user.relationship === 'accepted') {
          actionHtml = `<span style="font-size: 0.72rem; color: var(--success); font-weight: 600;">✓ Connected</span>`;
        } else if (user.relationship === 'pending_sent') {
          actionHtml = `<span style="font-size: 0.72rem; color: var(--warning); font-weight: 600;">⏳ Sent</span>`;
        } else if (user.relationship === 'pending_received') {
          actionHtml = `<button class="btn-sidebar-accept" style="padding: 3px 8px; font-size: 0.72rem; font-weight: 600; border-radius: 4px; background: var(--success); color: white; border: none; cursor: pointer;">✓ Accept</button>`;
        } else {
          actionHtml = `<button class="btn-sidebar-add" style="padding: 3px 8px; font-size: 0.72rem; font-weight: 600; border-radius: 4px; background: var(--primary); color: white; border: none; cursor: pointer;">➕ Add</button>`;
        }

        item.innerHTML = `
          <div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;">
            <div class="avatar-wrap" style="width: 28px; height: 28px; flex-shrink: 0;">
              <img src="${user.avatar}" alt="${user.username}" style="width: 100%; height: 100%; border-radius: 50%;" />
            </div>
            <div class="user-item-info" style="min-width: 0;">
              <div class="user-item-name" style="font-size: 0.8rem; font-weight: 600;">${user.username}</div>
              <div class="user-item-desc" style="font-size: 0.68rem; color: var(--text-muted);">${user.email || ''}</div>
            </div>
          </div>
          <div style="flex-shrink: 0; margin-left: 6px;">
            ${actionHtml}
          </div>
        `;

        const addBtn = item.querySelector('.btn-sidebar-add');
        if (addBtn) {
          addBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            addBtn.disabled = true;
            addBtn.textContent = '...';
            await this.sendContactRequest(user.id);
          });
        }

        const acceptBtn = item.querySelector('.btn-sidebar-accept');
        if (acceptBtn) {
          acceptBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            acceptBtn.disabled = true;
            acceptBtn.textContent = '...';
            await this.respondContactRequest(user.requestId, 'accept');
          });
        }

        discoverList.appendChild(item);
      });
    } catch (err) {
      console.error('Failed to search global sidebar users:', err);
      discoverList.innerHTML = `<div style="font-size: 0.75rem; color: var(--danger); padding: 0.4rem;">Error searching.</div>`;
    }
  }

  async sendContactRequest(targetIdentifier) {
    try {
      const res = await fetch('/api/contacts/request', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ targetIdentifier })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to send request');
      }

      this.showToast(data.autoAccepted ? 'Request accepted! You are now contacts.' : 'Contact request sent successfully!');
      
      const modal = document.getElementById('modal-add-contact');
      if (modal && !modal.classList.contains('hidden')) {
        const input = document.getElementById('input-search-users');
        this.searchAndRenderUsers(input ? input.value : '');
      }

      const sidebarSearch = document.getElementById('search-users');
      if (sidebarSearch && sidebarSearch.value.trim().length > 0) {
        this.searchAndRenderSidebarGlobal(sidebarSearch.value.trim());
      }

      window.chatSocket.emit('contacts:refresh');
    } catch (err) {
      alert(err.message);
      const input = document.getElementById('input-search-users');
      if (input) this.searchAndRenderUsers(input.value);
    }
  }

  async respondContactRequest(requestId, action) {
    try {
      const res = await fetch('/api/contacts/respond', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ requestId, action })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to respond to request');
      }

      this.showToast(action === 'accept' ? 'Contact request accepted! You are now connected.' : 'Contact request declined.');
      window.chatSocket.emit('contacts:refresh');
      
      const modal = document.getElementById('modal-add-contact');
      if (modal && !modal.classList.contains('hidden')) {
        const input = document.getElementById('input-search-users');
        this.searchAndRenderUsers(input ? input.value : '');
      }

      const sidebarSearch = document.getElementById('search-users');
      if (sidebarSearch && sidebarSearch.value.trim().length > 0) {
        this.searchAndRenderSidebarGlobal(sidebarSearch.value.trim());
      }
    } catch (err) {
      alert(err.message);
    }
  }

  showToast(message) {
    let toast = document.getElementById('app-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'app-toast';
      toast.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: var(--bg-surface);
        border: 1px solid var(--accent-primary);
        color: var(--text-primary);
        padding: 0.75rem 1.4rem;
        border-radius: var(--radius-full);
        box-shadow: 0 10px 30px rgba(0,0,0,0.6), var(--accent-glow);
        z-index: 3000;
        font-size: 0.88rem;
        font-weight: 500;
        transition: all 0.3s ease;
      `;
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.style.opacity = '1';
    toast.style.display = 'block';

    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => { toast.style.display = 'none'; }, 300);
    }, 3500);
  }

  switchActiveChat(userOrNull) {
    const messagesFeed = document.getElementById('messages-feed');
    messagesFeed.innerHTML = `
      <div class="system-message">
        Joined conversation with ${userOrNull ? userOrNull.username : '# General Channel'}. Messages and calls are end-to-end encrypted.
      </div>
    `;
  }

  renderChatHistory(messages) {
    const messagesFeed = document.getElementById('messages-feed');
    messagesFeed.innerHTML = '';
    messages.forEach(msg => this.appendMessage(msg));
  }

  handleIncomingMessage(message) {
    const isMine = message.senderId === this.currentUser?.id;
    const isGeneral = !message.targetUserId || message.roomId === 'general';

    if (isGeneral) {
      if (this.activeTarget === null) {
        // Active chat is General channel
        this.appendMessage(message);
      } else {
        // User is currently chatting in a DM
        this.incrementUnread('general');
        if (!isMine) {
          this.showToast(`💬 #General (${message.senderName}): ${message.content || 'Shared an attachment'}`);
        }
      }
    } else {
      // Direct message
      const peerId = isMine ? message.targetUserId : message.senderId;
      if (this.activeTarget && this.activeTarget.id === peerId) {
        // Active DM
        this.appendMessage(message);
      } else {
        // Inactive DM
        if (!isMine) {
          this.incrementUnread(peerId);
          this.showToast(`💬 ${message.senderName}: ${message.content || 'Sent an attachment'}`);
        }
      }
    }
  }

  incrementUnread(targetKey) {
    const count = (this.unreadCounts.get(targetKey) || 0) + 1;
    this.unreadCounts.set(targetKey, count);
    const displayCount = count > 99 ? '99+' : count;

    if (targetKey === 'general') {
      const badge = document.getElementById('unread-badge-general');
      if (badge) {
        badge.textContent = displayCount;
        badge.classList.remove('hidden');
        badge.classList.add('animate-pop');
        setTimeout(() => badge.classList.remove('animate-pop'), 400);
      }
      const dot = document.getElementById('channel-unread-dot');
      if (dot) dot.classList.remove('hidden');
    } else {
      const item = document.querySelector(`.user-item[data-user-id="${targetKey}"]`);
      if (item) {
        const badge = item.querySelector('.unread-badge');
        if (badge) {
          badge.textContent = displayCount;
          badge.classList.remove('hidden');
          badge.classList.add('animate-pop');
          setTimeout(() => badge.classList.remove('animate-pop'), 400);
        }
        const dot = item.querySelector('.avatar-unread-dot');
        if (dot) dot.classList.remove('hidden');
      }
    }

    this.updateTotalUnreadBadge();
  }

  clearUnread(targetKey) {
    if (!this.unreadCounts.has(targetKey) || this.unreadCounts.get(targetKey) === 0) return;
    this.unreadCounts.set(targetKey, 0);

    if (targetKey === 'general') {
      const badge = document.getElementById('unread-badge-general');
      if (badge) badge.classList.add('hidden');
      const dot = document.getElementById('channel-unread-dot');
      if (dot) dot.classList.add('hidden');
    } else {
      const item = document.querySelector(`.user-item[data-user-id="${targetKey}"]`);
      if (item) {
        const badge = item.querySelector('.unread-badge');
        if (badge) badge.classList.add('hidden');
        const dot = item.querySelector('.avatar-unread-dot');
        if (dot) dot.classList.add('hidden');
      }
    }

    this.updateTotalUnreadBadge();
  }

  updateTotalUnreadBadge() {
    let total = 0;
    for (const c of this.unreadCounts.values()) {
      total += c;
    }

    const totalBadge = document.getElementById('total-unread-badge');
    const brandDot = document.getElementById('brand-unread-dot');

    if (totalBadge) {
      if (total > 0) {
        totalBadge.textContent = total > 99 ? '99+' : total;
        totalBadge.classList.remove('hidden');
        totalBadge.classList.add('animate-pop');
        setTimeout(() => totalBadge.classList.remove('animate-pop'), 400);
      } else {
        totalBadge.classList.add('hidden');
      }
    }

    if (brandDot) {
      if (total > 0) brandDot.classList.remove('hidden');
      else brandDot.classList.add('hidden');
    }

    // Dynamic browser tab title with unread indicator
    if (total > 0) {
      document.title = `(${total}) ChatQ — Real-Time Chat`;
    } else {
      document.title = 'ChatQ — Real-Time Chat, Media Sharing & WebRTC Calling';
    }
  }

  appendMessage(msg) {
    const isMine = msg.senderId === this.currentUser?.id;
    const messagesFeed = document.getElementById('messages-feed');

    const row = document.createElement('div');
    row.className = `message-row ${isMine ? 'outgoing' : 'incoming'}`;

    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let attachmentHtml = '';
    if (msg.attachment) {
      const att = msg.attachment;
      if (att.type === 'image' || att.mimetype?.startsWith('image/')) {
        attachmentHtml = `
          <div class="attachment-card">
            <img class="media-img-preview" src="${att.url}" alt="${att.filename || 'Image'}" onclick="window.ui.openLightbox('${att.url}')" />
          </div>
        `;
      } else if (att.type === 'video' || att.mimetype?.startsWith('video/')) {
        attachmentHtml = `
          <div class="attachment-card">
            <video class="media-video-preview" controls src="${att.url}"></video>
          </div>
        `;
      } else if (att.type === 'audio_note' || att.type === 'audio' || att.mimetype?.startsWith('audio/')) {
        attachmentHtml = `
          <div class="attachment-card">
            <audio class="media-audio-player" controls src="${att.url}"></audio>
          </div>
        `;
      } else {
        attachmentHtml = `
          <a class="file-download-box" href="${att.url}" download="${att.filename}">
            <span class="file-icon">📁</span>
            <div class="file-details">
              <span class="file-name">${att.filename}</span>
              <span class="file-size">${this.formatFileSize(att.size)}</span>
            </div>
          </a>
        `;
      }
    }

    const contentHtml = msg.content ? `<div>${this.escapeHtml(msg.content)}</div>` : '';

    row.innerHTML = `
      <img class="msg-avatar" src="${msg.senderAvatar}" alt="${msg.senderName}" />
      <div class="message-bubble">
        <span class="msg-sender-name">${msg.senderName}</span>
        <div class="msg-content">
          ${contentHtml}
          ${attachmentHtml}
        </div>
        <span class="msg-time">${timeStr}</span>
      </div>
    `;

    messagesFeed.appendChild(row);
    messagesFeed.scrollTop = messagesFeed.scrollHeight;
  }

  setTypingIndicator(username, isTyping) {
    const indicator = document.getElementById('typing-indicator');
    if (isTyping) {
      indicator.innerHTML = `
        <div class="typing-dots">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
        <span>${username} is typing...</span>
      `;
    } else {
      indicator.innerHTML = '';
    }
  }

  openLightbox(url) {
    const lightboxModal = document.getElementById('lightbox-modal');
    document.getElementById('lightbox-img').src = url;
    lightboxModal.classList.remove('hidden');
  }

  formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.innerText = str;
    return div.innerHTML;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.ui = new ChatAppUI();
});
