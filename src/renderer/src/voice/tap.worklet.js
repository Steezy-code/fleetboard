// The push-to-talk microphone tap, as a file rather than a string.
//
// This used to be a template literal turned into a blob: URL, which is why script-src carried blob: —
// and blob: in script-src is the shortest path from "something injected a string into the page" to
// "that string ran". It is one worklet; it can be a file, and then the grant goes away.
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('fb-tap', Tap)
