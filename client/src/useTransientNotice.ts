import { useCallback, useEffect, useState } from "react";
import {
  createTransientNoticeController,
  TRANSIENT_ERROR_NOTICE_MS,
  TRANSIENT_NOTICE_MS
} from "../../src/transient-notice.js";

export { TRANSIENT_NOTICE_MS, TRANSIENT_ERROR_NOTICE_MS };

/**
 * Transient toast state for settings / admin notices.
 * Success/info auto-dismiss; new messages reset the timer; timers clear on unmount.
 */
export function useTransientNotice(successMs = TRANSIENT_NOTICE_MS, errorMs = TRANSIENT_ERROR_NOTICE_MS) {
  const [notice, setNoticeState] = useState("");
  const [controller] = useState(() =>
    createTransientNoticeController({
      successMs,
      errorMs,
      onChange: setNoticeState
    })
  );

  useEffect(() => () => controller.dispose(), [controller]);

  const setNotice = useCallback((value: string) => {
    controller.set(value);
  }, [controller]);

  const clearNotice = useCallback(() => {
    controller.clear();
  }, [controller]);

  return { notice, setNotice, clearNotice };
}
