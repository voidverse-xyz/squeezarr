// App logo — the Squeezarr mark: two cyan chevrons squeezing a play triangle (the "squeeze a
// video" idea), inside a rounded-square tile. Kept in sync with the favicon (app/icon.svg): edit
// both together, then regenerate favicon.ico from icon.svg. Inlined so it can sit next to the
// title and scale crisply. Size in px (square); defaults to a header-friendly 22.
export default function Logo({ size = 22, className = "" }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 32 32"
            width={size}
            height={size}
            className={className}
            aria-hidden="true"
        >
            <rect x="1" y="1" width="30" height="30" rx="7" fill="#0f172a" stroke="#1e293b" />
            {/* Two chevrons squeezing a play triangle */}
            <path
                d="M5 11 L10 16 L5 21"
                fill="none"
                stroke="#38bdf8"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <path
                d="M27 11 L22 16 L27 21"
                fill="none"
                stroke="#38bdf8"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <path d="M12.5 11 L19.5 16 L12.5 21 Z" fill="#e2e8f0" />
        </svg>
    );
}
