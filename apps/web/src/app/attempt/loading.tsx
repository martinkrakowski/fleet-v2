// Shown while the server page loads the attempt (the missing-id probe can take up to the API timeout).
export default function Loading() {
  return (
    <p role="status" aria-busy="true">
      Loading the attempt…
    </p>
  );
}
