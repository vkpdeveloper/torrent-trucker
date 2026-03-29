/**
 * Stub for node-datachannel — prevents the native NAPI module from loading
 * under Bun (which doesn't support uv_timer_init yet).
 * WebTorrent gracefully degrades to TCP/UDP BitTorrent without WebRTC.
 */

class PeerConnection extends EventTarget {
  constructor() { super() }
  setLocalDescription() {}
  setRemoteDescription() {}
  addRemoteCandidate() {}
  createDataChannel() { return new DataChannel() }
  close() {}
  destroy() {}
}

class DataChannel extends EventTarget {
  constructor() { super() }
  sendMessage() {}
  sendBuffer() {}
  close() {}
}

const nodeDataChannel = {
  PeerConnection,
  DataChannel,
  initLogger() {},
  cleanup() {},
  preload() {},
  setSctpSettings() {},
  getLibraryVersion() { return '0.0.0-stub' },
  Audio: class Audio {},
  Video: class Video {},
  Track: class Track {},
  IceUdpMuxListener: class IceUdpMuxListener {},
  RtpPacketizationConfig: class RtpPacketizationConfig {},
  PacingHandler: class PacingHandler {},
  RtcpReceivingSession: class RtcpReceivingSession {},
  RtcpNackResponder: class RtcpNackResponder {},
  RtcpSrReporter: class RtcpSrReporter {},
  RtpPacketizer: class RtpPacketizer {},
  H264RtpPacketizer: class H264RtpPacketizer {},
  H265RtpPacketizer: class H265RtpPacketizer {},
  AV1RtpPacketizer: class AV1RtpPacketizer {},
  DataChannelStream: class DataChannelStream {},
  WebSocket: class WebSocket {},
  WebSocketServer: class WebSocketServer { listen() {} stop() {} },
}

export default nodeDataChannel
export const { PeerConnection: PeerConnectionExport, DataChannel: DataChannelExport } = nodeDataChannel
export const polyfill = {
  RTCPeerConnection: PeerConnection,
  RTCDataChannel: DataChannel,
}
