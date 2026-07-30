import type { MasterResume } from "./types";

/**
 * The master resume — the single source of truth for every tailored version.
 *
 * Transcribed from Bo_Price_Resume.pdf. Edit this file (or use the "Master
 * resume" page in the app, which layers an override on top of it) whenever the
 * underlying facts change. The tailoring step is allowed to reword and reorder
 * what's here; it is not allowed to add employers, dates, metrics, or skills.
 */
export const MASTER_RESUME: MasterResume = {
  name: "Bo Price",
  location: "Atlanta, GA",
  email: "ltprice21@gmail.com",
  phone: "(304) 380-1973",
  links: [
    {
      label: "linkedin.com/in/bo-price-256763235",
      url: "https://linkedin.com/in/bo-price-256763235",
    },
  ],
  summary:
    "Global operations and supply chain coordinator with experience spanning international logistics, key account management, and audit program delivery.",
  roles: [
    {
      id: "ami",
      title: "Coordinator, Global Operations – International",
      company: "AMI Group",
      location: "Atlanta, GA",
      start: "Mar 2025",
      end: "Present",
      bullets: [
        "Reports directly to VP of Operations, leads international logistics operations, coordinating intercontinental shipments across Europe and the U.S. to ensure compliant, on-time, and cost-efficient delivery.",
        "Key account management of wine portfolio of 13 international airlines with combined annual sales volume of approximately $7 million USD.",
        "Manages full order-to-cash lifecycle, including sales order entry, fulfillment, shipment scheduling, documentation, and invoicing.",
        "Works across divisions internally overseeing inventory planning, monitoring stock levels and demand forecasts to prevent supply gaps and minimize excess.",
      ],
    },
    {
      id: "nsf",
      title: "Coordinator II – Supply Chain (Food Safety)",
      company: "NSF International",
      location: "",
      start: "Jul 2023",
      end: "Mar 2025",
      bullets: [
        "Oversaw quality metrics for supply chain audit programs and improved reporting processes for over 100+ active projects.",
        "Achieved a 25% reduction in overdue auditor training compliance through proactive tracking and communication.",
        "Supported business development by identifying new client opportunities and assisting with proposal preparation.",
        "Served as primary liaison between clients, auditors, and internal teams to ensure accurate documentation, scheduling, and project execution.",
      ],
    },
    {
      id: "agiliti",
      title: "Operations & Logistics Support",
      company: "Agiliti",
      location: "Novi, MI",
      start: "Jun 2022",
      end: "Jul 2023",
      bullets: [
        "Coordinated delivery and retrieval of specialized medical equipment across interstate and international networks.",
        "Built and maintained inventory reports, work orders, and asset-tracking processes to improve operational visibility.",
        "Collaborated with customer service and sales teams to streamline order flow and reduce service delays.",
      ],
    },
    {
      id: "guard",
      title: "Material & Maintenance Planner – Special Operations Support",
      company: "Army National Guard",
      location: "",
      start: "Apr 2020",
      end: "Apr 2026",
      bullets: [
        "Managed maintenance planning for multi-vehicle fleets, reducing downtime through proactive cycle scheduling.",
        "Created and tracked work orders, vehicle usage logs, and maintenance compliance reports.",
        "Directed vehicle dispatch, parts distribution, and readiness coordination supporting mission-critical operations.",
        "Conducted inventory audits and maintained accurate stock levels for equipment, tools, and repair materials.",
        "Led, trained, and mentored new soldiers in SAP inventory management applications.",
      ],
    },
  ],
  education: [
    {
      degree: "Master's Degree – Criminal Justice Administration",
      school: "West Virginia State University",
    },
    {
      degree: "Bachelor's Degree – Criminology",
      school: "West Virginia University",
    },
  ],
  certifications: [
    "Salesforce Administrator",
    "Georgia Real Estate Commission – Salesperson",
  ],
  skills: [
    "International logistics & intercontinental shipping",
    "Order-to-cash lifecycle management",
    "Key account management",
    "Inventory planning & demand forecasting",
    "Export documentation & trade compliance",
    "Supply chain audit programs",
    "Quality metrics & reporting",
    "Scheduling & project coordination",
    "Client, auditor & vendor liaison",
    "Proposal support & business development",
    "Asset tracking & work order management",
    "Maintenance planning & fleet readiness",
    "SAP inventory management",
    "Salesforce administration",
    "Cross-functional collaboration",
    "Training & mentoring",
  ],
};
