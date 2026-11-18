import { Text } from "@salt-ds/core";
import "./app.css";
import "./theme.scss";
import styles from "./Card.module.scss";

export const Page = () => (
  <main className="page">
    <div className={styles.card}>
      <header className={styles.card__header}>
        <Text>Hello</Text>
      </header>
      <footer className={styles.card__footer} />
    </div>
  </main>
);
