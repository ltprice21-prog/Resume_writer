import {
  Document,
  Page,
  Text,
  View,
  Link,
  Font,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";
import type { TailoredResume } from "./types";

// react-pdf hyphenates at line breaks by default, which bakes "docu-mentation"
// into the text layer and breaks keyword matching in applicant tracking systems.
// Returning the word whole disables it.
Font.registerHyphenationCallback((word) => [word]);

/**
 * ATS-friendly layout rules this template follows:
 *  - Single column, no tables, no text boxes, no columns, no images.
 *  - Standard PDF core fonts (Helvetica) — real, extractable text.
 *  - Section headings in plain uppercase words parsers recognise.
 *  - Bullets rendered as a literal "•" plus text on one line, so extraction
 *    yields one bullet per line rather than a jumble.
 */
const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 36,
    paddingHorizontal: 46,
    fontFamily: "Helvetica",
    fontSize: 9.5,
    lineHeight: 1.35,
    color: "#111111",
  },
  name: {
    fontSize: 18,
    fontFamily: "Helvetica-Bold",
    marginBottom: 6,
  },
  contact: { fontSize: 9, color: "#333333", marginBottom: 2 },
  link: { fontSize: 9, color: "#333333", textDecoration: "none" },
  rule: {
    borderBottomWidth: 1,
    borderBottomColor: "#111111",
    marginTop: 8,
    marginBottom: 7,
  },
  sectionHeading: {
    // No letterSpacing: it makes some PDF text extractors emit "S U M M A RY",
    // which stops an ATS recognising the section header.
    fontSize: 9.5,
    fontFamily: "Helvetica-Bold",
    marginBottom: 5,
  },
  section: { marginBottom: 9 },
  summary: { marginBottom: 2 },
  roleHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 1,
  },
  roleTitle: { fontSize: 10, fontFamily: "Helvetica-Bold", flexShrink: 1 },
  roleDates: { fontSize: 9, color: "#333333", marginLeft: 12 },
  roleCompany: { fontSize: 9.5, color: "#333333", marginBottom: 3 },
  role: { marginBottom: 8 },
  bulletRow: { flexDirection: "row", marginBottom: 2 },
  bulletMark: { width: 10 },
  bulletText: { flex: 1 },
  entry: { marginBottom: 2.5 },
  entryPrimary: { fontFamily: "Helvetica-Bold" },
});

function Bullet({ children }: { children: string }) {
  return (
    <View style={styles.bulletRow} wrap={false}>
      <Text style={styles.bulletMark}>•</Text>
      <Text style={styles.bulletText}>{children}</Text>
    </View>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeading}>{title}</Text>
      {children}
    </View>
  );
}

export function ResumeDocument({ resume }: { resume: TailoredResume }) {
  const contactLine = [resume.location, resume.email, resume.phone]
    .filter(Boolean)
    .join("  •  ");

  return (
    <Document
      title={`${resume.name} — Resume`}
      author={resume.name}
      subject="Resume"
      creator="Resume Writer"
      producer="Resume Writer"
    >
      <Page size="LETTER" style={styles.page}>
        <View>
          <Text style={styles.name}>{resume.name}</Text>
          <Text style={styles.contact}>{contactLine}</Text>
          {resume.links.map((link) => (
            <Link key={link.url} src={link.url} style={styles.link}>
              {link.label}
            </Link>
          ))}
        </View>

        <View style={styles.rule} />

        {resume.summary ? (
          <Section title="SUMMARY">
            <Text style={styles.summary}>{resume.summary}</Text>
          </Section>
        ) : null}

        {resume.skills.length > 0 ? (
          <Section title="CORE SKILLS">
            {/* Comma-separated, not bullet-separated: parsers split this line on
                commas reliably, whereas a mid-line "•" can survive extraction as
                stray punctuation. */}
            <Text>{resume.skills.join(", ")}</Text>
          </Section>
        ) : null}

        <Section title="EXPERIENCE">
          {resume.roles.map((role) => (
            <View key={role.id} style={styles.role} wrap={false}>
              <View style={styles.roleHeader}>
                <Text style={styles.roleTitle}>{role.title}</Text>
                <Text style={styles.roleDates}>
                  {role.start} – {role.end}
                </Text>
              </View>
              <Text style={styles.roleCompany}>
                {[role.company, role.location].filter(Boolean).join("  |  ")}
              </Text>
              {role.bullets.map((bullet, i) => (
                <Bullet key={i}>{bullet}</Bullet>
              ))}
            </View>
          ))}
        </Section>

        <Section title="EDUCATION">
          {resume.education.map((entry) => (
            <View key={entry.degree} style={styles.entry}>
              <Text>
                <Text style={styles.entryPrimary}>{entry.degree}</Text>
                {`  |  ${[entry.school, entry.detail].filter(Boolean).join("  |  ")}`}
              </Text>
            </View>
          ))}
        </Section>

        {resume.certifications.length > 0 ? (
          <Section title="CERTIFICATIONS AND LICENSES">
            {resume.certifications.map((cert) => (
              <Bullet key={cert}>{cert}</Bullet>
            ))}
          </Section>
        ) : null}
      </Page>
    </Document>
  );
}

export async function renderResumePdf(resume: TailoredResume): Promise<Buffer> {
  return renderToBuffer(<ResumeDocument resume={resume} />);
}
