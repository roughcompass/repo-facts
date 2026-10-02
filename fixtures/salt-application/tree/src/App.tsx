import { Button, StackLayout, Text } from "@salt-ds/core";
import clsx from "clsx";
import styles from "./App.module.css";
import { Primary } from "./components/Primary";

// <Button className="decoy" /> in a comment is not an element.
const note = '<button class="decoy">not an element</button>';

export function App({ active }: { active: boolean }) {
  return (
    <StackLayout gap={2}>
      <Text>{note.length}</Text>
      <Button appearance="transparent" sentiment="neutral">
        Refresh
      </Button>
      <Button className={clsx(styles.toggle, active && styles.active)}>Toggle</Button>
      <Primary tone="accent">Submit</Primary>
      <button type="button">Raw</button>
      <div className={styles.row}>
        <span>Unstyled</span>
      </div>
      <div className="tone">Custom</div>
      <div style={{ minHeight: 220 }}>Inline</div>
    </StackLayout>
  );
}
