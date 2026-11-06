"use client";

import dynamic from "next/dynamic";

import styles from "./docs.module.css";

// Scalar renders in the browser only (it reads window and mounts a Vue app).
const ApiReference = dynamic(() => import("./api-reference"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading} aria-hidden>
      <span />
      <span />
      <span />
    </div>
  ),
});

export function ApiDocs() {
  return (
    <div className={styles.page}>
      <h1 className="visually-hidden">QRB API reference</h1>
      <ApiReference />
    </div>
  );
}
