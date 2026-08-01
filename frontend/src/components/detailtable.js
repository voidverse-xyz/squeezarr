// Two-column key/value table used in the expanded rows of the files and jobs tables.
export default function DetailTable({ rows }) {
    return (
        <table className="text-[11px]">
            <tbody>
                {rows.map(([label, value], idx) => (
                    <tr key={idx}>
                        <td className="text-muted-foreground pr-3 py-0.5 align-top whitespace-nowrap">{label}</td>
                        <td className="py-0.5 align-top">{value}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
