// WebRTC Audio/Video Call Manager for ChatQ
class WebRTCManager {
  constructor() {
    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;
    this.screenStream = null;

    this.currentCall = null; // { peerId, peerName, peerAvatar, type, isCaller, status: 'calling'|'ringing'|'connected' }
    this.iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ];

    this.isMuted = false;
    this.isVideoOff = false;
    this.isScreenSharing = false;

    this.callTimerInterval = null;
    this.callDurationSec = 0;

    this.audioVisualizerAnim = null;
  }

  // Check device support
  checkSupport() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RTCPeerConnection);
  }

  // 1. Caller initiates call
  async startCall(targetUser, callType = 'video') {
    if (!this.checkSupport()) {
      alert('Your browser does not support WebRTC media calling.');
      return;
    }

    if (this.currentCall) {
      alert('You are already in an active call.');
      return;
    }

    this.currentCall = {
      peerId: targetUser.id,
      peerName: targetUser.username,
      peerAvatar: targetUser.avatar,
      type: callType,
      isCaller: true,
      status: 'calling'
    };

    window.sounds.startOutgoingRingback();
    this.openCallModal('Calling ' + targetUser.username + '...');

    // Notify server to ping the target user
    window.chatSocket.emit('call:initiate', {
      targetUserId: targetUser.id,
      type: callType
    });
  }

  // 2. Callee receives incoming call alert
  handleIncomingCall(caller, type) {
    if (this.currentCall) {
      // Callee is already busy
      window.chatSocket.emit('call:reject', {
        targetUserId: caller.id,
        reason: 'busy'
      });
      return;
    }

    this.currentCall = {
      peerId: caller.id,
      peerName: caller.username,
      peerAvatar: caller.avatar,
      type: type,
      isCaller: false,
      status: 'ringing'
    };

    window.sounds.startIncomingRingtone();
    this.showIncomingModal(caller, type);
  }

  // 3. Callee accepts call
  async acceptCall() {
    if (!this.currentCall) return;

    window.sounds.stopIncomingRingtone();
    this.hideIncomingModal();

    try {
      await this.acquireLocalMedia(this.currentCall.type);
      this.openCallModal('Connecting with ' + this.currentCall.peerName + '...');

      window.chatSocket.emit('call:accept', {
        targetUserId: this.currentCall.peerId,
        type: this.currentCall.type
      });

      this.initPeerConnection();
    } catch (err) {
      console.error('Error acquiring media on accept:', err);
      alert('Unable to access microphone/camera: ' + err.message);
      this.rejectCall('Device access denied');
    }
  }

  // 4. Callee rejects call
  rejectCall(reason = 'declined') {
    window.sounds.stopIncomingRingtone();
    this.hideIncomingModal();

    if (this.currentCall) {
      window.chatSocket.emit('call:reject', {
        targetUserId: this.currentCall.peerId,
        reason
      });
      this.currentCall = null;
    }
  }

  // 5. Caller handles 'call:accepted' from server
  async onCallAccepted(callee, type) {
    window.sounds.stopOutgoingRingback();
    this.currentCall.status = 'connected';
    this.currentCall.type = type;

    try {
      await this.acquireLocalMedia(type);
      this.initPeerConnection();

      // Create Offer
      const offer = await this.peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: type === 'video'
      });
      await this.peerConnection.setLocalDescription(offer);

      window.chatSocket.emit('webrtc:offer', {
        targetUserId: callee.id,
        offer
      });

      this.startDurationTimer();
      this.updateCallUI();
    } catch (err) {
      console.error('Error creating offer:', err);
      this.endCall();
    }
  }

  // 6. Handle offer received (callee side)
  async handleOffer(fromUserId, offer) {
    if (!this.peerConnection) {
      this.initPeerConnection();
    }

    try {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);

      window.chatSocket.emit('webrtc:answer', {
        targetUserId: fromUserId,
        answer
      });

      if (this.currentCall) {
        this.currentCall.status = 'connected';
        this.startDurationTimer();
        this.updateCallUI();
      }
    } catch (err) {
      console.error('Error handling offer:', err);
    }
  }

  // 7. Handle answer received (caller side)
  async handleAnswer(answer) {
    if (this.peerConnection) {
      try {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (err) {
        console.error('Error setting remote description from answer:', err);
      }
    }
  }

  // 8. Handle ICE candidates
  async handleIceCandidate(candidate) {
    if (this.peerConnection && candidate) {
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('Error adding ICE candidate:', err);
      }
    }
  }

  // Setup PeerConnection
  initPeerConnection() {
    this.peerConnection = new RTCPeerConnection({ iceServers: this.iceServers });

    // Add local tracks to PC
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        this.peerConnection.addTrack(track, this.localStream);
      });
    }

    // Remote ICE candidate found
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.currentCall) {
        window.chatSocket.emit('webrtc:ice-candidate', {
          targetUserId: this.currentCall.peerId,
          candidate: event.candidate
        });
      }
    };

    // Receive remote media tracks
    this.peerConnection.ontrack = (event) => {
      console.log('[WebRTC] Received remote stream track:', event.track.kind);
      const remoteVideo = document.getElementById('remote-video');
      if (!this.remoteStream) {
        this.remoteStream = new MediaStream();
        remoteVideo.srcObject = this.remoteStream;
      }
      this.remoteStream.addTrack(event.track);

      this.updateCallUI();
    };

    this.peerConnection.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state:', this.peerConnection.connectionState);
      if (['disconnected', 'failed', 'closed'].includes(this.peerConnection.connectionState)) {
        this.endCall(false);
      }
    };
  }

  // Acquire camera / mic
  async acquireLocalMedia(type) {
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: type === 'video' ? {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user'
      } : false
    };

    this.localStream = await navigator.mediaDevices.getUserMedia(constraints);

    const localVideo = document.getElementById('local-video');
    localVideo.srcObject = this.localStream;
    localVideo.muted = true; // prevent local feedback echo

    if (type === 'audio') {
      this.startAudioVisualizer(this.localStream);
    }
  }

  // Mute / Unmute mic
  toggleMute() {
    if (!this.localStream) return;
    this.isMuted = !this.isMuted;
    this.localStream.getAudioTracks().forEach(track => {
      track.enabled = !this.isMuted;
    });

    const muteBtn = document.getElementById('btn-mute');
    muteBtn.classList.toggle('off', this.isMuted);
    muteBtn.innerHTML = this.isMuted
      ? `<svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/><line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" stroke-width="2"/></svg>`
      : `<svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/></svg>`;
  }

  // Video Camera On / Off
  toggleVideo() {
    if (!this.localStream) return;
    const videoTracks = this.localStream.getVideoTracks();
    if (videoTracks.length === 0) return;

    this.isVideoOff = !this.isVideoOff;
    videoTracks.forEach(track => {
      track.enabled = !this.isVideoOff;
    });

    const videoBtn = document.getElementById('btn-video-toggle');
    videoBtn.classList.toggle('off', this.isVideoOff);
    videoBtn.innerHTML = this.isVideoOff
      ? `<svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/><line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" stroke-width="2"/></svg>`
      : `<svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>`;
  }

  // Screen Sharing
  async toggleScreenShare() {
    if (!navigator.mediaDevices.getDisplayMedia) {
      alert('Screen sharing is not supported by your browser.');
      return;
    }

    const shareBtn = document.getElementById('btn-screen-share');

    if (!this.isScreenSharing) {
      try {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = this.screenStream.getVideoTracks()[0];

        // Replace track in RTCPeerConnection
        if (this.peerConnection) {
          const sender = this.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) {
            sender.replaceTrack(screenTrack);
          }
        }

        // Show screen share on local video
        document.getElementById('local-video').srcObject = this.screenStream;

        screenTrack.onended = () => {
          this.stopScreenShare();
        };

        this.isScreenSharing = true;
        shareBtn.classList.add('off');
      } catch (err) {
        console.error('Screen sharing canceled or failed:', err);
      }
    } else {
      this.stopScreenShare();
    }
  }

  stopScreenShare() {
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }

    if (this.localStream && this.peerConnection) {
      const cameraTrack = this.localStream.getVideoTracks()[0];
      const sender = this.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender && cameraTrack) {
        sender.replaceTrack(cameraTrack);
      }
      document.getElementById('local-video').srcObject = this.localStream;
    }

    this.isScreenSharing = false;
    const shareBtn = document.getElementById('btn-screen-share');
    if (shareBtn) shareBtn.classList.remove('off');
  }

  // End Call
  endCall(notifyServer = true) {
    window.sounds.stopOutgoingRingback();
    window.sounds.stopIncomingRingtone();
    window.sounds.playCallEnd();

    if (notifyServer && this.currentCall) {
      window.chatSocket.emit('call:end', {
        targetUserId: this.currentCall.peerId
      });
    }

    // Stop streams
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }
    this.remoteStream = null;

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.stopDurationTimer();
    this.stopAudioVisualizer();
    this.closeCallModal();
    this.hideIncomingModal();

    this.currentCall = null;
    this.isMuted = false;
    this.isVideoOff = false;
    this.isScreenSharing = false;
  }

  // UI Helpers
  openCallModal(initialTitle) {
    const modal = document.getElementById('call-overlay');
    modal.classList.remove('hidden');

    document.getElementById('call-peer-title').textContent = initialTitle || 'Active Call';
    document.getElementById('call-peer-avatar').src = this.currentCall?.peerAvatar || '';
    document.getElementById('call-duration').textContent = '00:00';
    this.updateCallUI();
  }

  closeCallModal() {
    const modal = document.getElementById('call-overlay');
    modal.classList.add('hidden');
    document.getElementById('remote-video').srcObject = null;
    document.getElementById('local-video').srcObject = null;
  }

  updateCallUI() {
    const isVideo = this.currentCall?.type === 'video';
    const videoStage = document.getElementById('remote-video');
    const audioStage = document.getElementById('audio-call-stage');
    const localPip = document.getElementById('local-video-pip');
    const videoToggleBtn = document.getElementById('btn-video-toggle');
    const screenShareBtn = document.getElementById('btn-screen-share');

    if (isVideo) {
      videoStage.style.display = 'block';
      audioStage.style.display = 'none';
      localPip.style.display = 'block';
      videoToggleBtn.style.display = 'flex';
      screenShareBtn.style.display = 'flex';
    } else {
      videoStage.style.display = 'none';
      audioStage.style.display = 'flex';
      localPip.style.display = 'none';
      videoToggleBtn.style.display = 'none';
      screenShareBtn.style.display = 'none';
      document.getElementById('audio-stage-avatar-img').src = this.currentCall?.peerAvatar || '';
    }
  }

  showIncomingModal(caller, type) {
    const modal = document.getElementById('incoming-call-modal');
    modal.classList.remove('hidden');

    document.getElementById('incoming-caller-avatar-img').src = caller.avatar;
    document.getElementById('incoming-caller-name').textContent = caller.username;
    document.getElementById('incoming-call-type').textContent = `Incoming ${type.toUpperCase()} Call...`;
  }

  hideIncomingModal() {
    document.getElementById('incoming-call-modal').classList.add('hidden');
  }

  startDurationTimer() {
    this.stopDurationTimer();
    this.callDurationSec = 0;
    this.callTimerInterval = setInterval(() => {
      this.callDurationSec++;
      const mins = String(Math.floor(this.callDurationSec / 60)).padStart(2, '0');
      const secs = String(this.callDurationSec % 60).padStart(2, '0');
      document.getElementById('call-duration').textContent = `${mins}:${secs}`;
    }, 1000);
  }

  stopDurationTimer() {
    if (this.callTimerInterval) {
      clearInterval(this.callTimerInterval);
      this.callTimerInterval = null;
    }
  }

  // Audio Visualizer
  startAudioVisualizer(stream) {
    const canvas = document.getElementById('audio-visualizer');
    if (!canvas) return;
    const canvasCtx = canvas.getContext('2d');

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      this.audioVisualizerAnim = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
      const barWidth = (canvas.width / bufferLength) * 2;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * canvas.height;
        canvasCtx.fillStyle = '#6366f1';
        canvasCtx.fillRect(x, canvas.height - barHeight, barWidth - 2, barHeight);
        x += barWidth;
      }
    };
    draw();
  }

  stopAudioVisualizer() {
    if (this.audioVisualizerAnim) {
      cancelAnimationFrame(this.audioVisualizerAnim);
      this.audioVisualizerAnim = null;
    }
  }
}

window.webrtc = new WebRTCManager();
