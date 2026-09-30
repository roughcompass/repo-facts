import { useEffect, useRef } from "react";

export function LegacyFrame() {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    window.addEventListener("message", (event) => void event);
  }, []);
  const note = "<iframe src=\"http://decoy.example.test\"></iframe>";
  return <iframe ref={frame} src="http://127.0.0.1:9103" title="Legacy servicing" />;
}
