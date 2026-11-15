/** Small transport/tab marks shared by the address bar and tab strip. */

export function OnionIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 21c4.7 0 8.2-3.7 8.2-8.2C20.2 7.4 16.5 3 12 3S3.8 7.4 3.8 12.8C3.8 17.3 7.3 21 12 21Z" />
      <path d="M12 18.2c2.9 0 5.1-2.4 5.1-5.5 0-3.2-1.9-5.7-5.1-5.7s-5.1 2.5-5.1 5.7c0 3.1 2.2 5.5 5.1 5.5Z" />
      <path d="M12 15.3c1.3 0 2.2-1.1 2.2-2.7 0-1.6-.9-2.7-2.2-2.7s-2.2 1.1-2.2 2.7c0 1.6.9 2.7 2.2 2.7Z" />
      <path d="M12 3c0-1 .6-1.7 1.6-2" />
    </svg>
  )
}
