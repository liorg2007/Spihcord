/**
 * RTCRtpSender.setParameters helper shared by the screen-share and camera senders.
 */

/** getParameters -> mutate -> setParameters; retries without degradationPreference if rejected. */
export async function updateSenderParams(
  sender: RTCRtpSender,
  mutate: (p: RTCRtpSendParameters) => void,
  degradationPreference?: RTCDegradationPreference,
): Promise<boolean> {
  for (const withPref of degradationPreference ? [true, false] : [false]) {
    const p = sender.getParameters() as RTCRtpSendParameters;
    if (!p.encodings || p.encodings.length === 0) return false; // not negotiated yet; retried later
    mutate(p);
    if (withPref) p.degradationPreference = degradationPreference;
    try {
      await sender.setParameters(p);
      return true;
    } catch (err) {
      if (!withPref) throw err;
    }
  }
  return false;
}
