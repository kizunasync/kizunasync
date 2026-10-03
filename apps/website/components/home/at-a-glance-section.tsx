import { AT_A_GLANCE } from '@/components/home/at-a-glance.data'

export function AtAGlanceSection() {
  return (
    <section className="sr-only" aria-label="Kizuna at a glance">
      <h2>Kizuna at a glance</h2>
      <table>
        <thead>
          <tr>
            <th>Capability</th>
            <th>Kizuna</th>
          </tr>
        </thead>
        <tbody>
          {AT_A_GLANCE.map(([label, value]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
