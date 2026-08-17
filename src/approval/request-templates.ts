import * as z from "zod/v4";

import { ApprovalMcpError } from "../core/errors.js";
import { asRecord, text, unwrapResult } from "./normalize.js";

export const APPROVAL_REQUEST_TEMPLATES = ["expense_reimbursement", "payment_request"] as const;
export type ApprovalRequestTemplate = (typeof APPROVAL_REQUEST_TEMPLATES)[number];

export const MWE_COMPANIES = [
  "深圳市玛威尔显控科技有限公司",
  "深圳市玛威尔运营管理有限公司",
  "深圳市利华博科技有限公司",
  "深圳市玛威尔科创集团有限公司",
] as const;

const expenseItemSchema = z
  .object({
    amount: z.number().positive().finite(),
    category: z.enum(["AI费用", "其它"]),
    expenseDepartment: z.string().trim().min(1).max(100),
    remark: z.string().trim().min(1).max(500),
  })
  .strict();

export const expenseReimbursementFieldsSchema = z
  .object({
    company: z.enum(MWE_COMPANIES).optional(),
    date: z.iso.date(),
    reason: z.string().trim().min(1).max(2000),
    counterparty: z.string().trim().min(1).max(200),
    items: z.array(expenseItemSchema).min(1).max(50),
  })
  .strict();

const paymentLineSchema = z
  .object({
    purpose: z.string().trim().min(1).max(200),
    amount: z.number().positive().finite(),
    reason: z.string().trim().min(1).max(500),
    expenseDepartment: z.string().trim().min(1).max(100),
    beneficiaryBankAccount: z.string().trim().max(100).optional(),
    beneficiaryAccountName: z.string().trim().max(200).optional(),
    beneficiaryBankName: z.string().trim().max(200).optional(),
    paymentMethod: z.string().trim().max(100).optional(),
    payerBankAccount: z.string().trim().max(100).optional(),
    payerAccountName: z.string().trim().max(200).optional(),
    payerBankName: z.string().trim().max(200).optional(),
  })
  .strict();

export const paymentRequestFieldsSchema = z
  .object({
    documentNumber: z.string().trim().min(1).max(100),
    company: z.enum(MWE_COMPANIES).optional(),
    counterparty: z.string().trim().max(200).optional(),
    payee: z.string().trim().min(1).max(200),
    currency: z.string().trim().min(1).max(20),
    applicationDate: z.iso.date(),
    lines: z.array(paymentLineSchema).min(1).max(50),
  })
  .strict();

export type ExpenseReimbursementFields = z.infer<typeof expenseReimbursementFieldsSchema>;
export type PaymentRequestFields = z.infer<typeof paymentRequestFieldsSchema>;
export type ApprovalRequestFields = ExpenseReimbursementFields | PaymentRequestFields;

export interface ApplicantFormContext {
  applicantName: string;
  departmentName: string;
}

export interface ApprovalAttachmentFormValue {
  fileId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  spaceId: string;
}

export type ApprovalAttachmentField = "invoice" | "other" | "attachment";

interface TemplateContract {
  processCode: string;
  title: string;
  expectedComponents: ReadonlyArray<{ id: string; label: string; componentName: string }>;
  expectedOptions: Readonly<Partial<Record<string, ReadonlyArray<{ value: string; key: string }>>>>;
  attachmentComponents: Partial<Record<ApprovalAttachmentField, { id: string; label: string }>>;
}

export const APPROVAL_REQUEST_CONTRACTS: Record<ApprovalRequestTemplate, TemplateContract> = {
  expense_reimbursement: {
    processCode: "PROC-2DB91B79-3CDD-421D-A223-0489A7BAB2C0",
    title: "费用报销",
    expectedComponents: [
      expected("DDSelectField_N9CRRWAYASW0", "申请员工", "DDSelectField"),
      expected("DDSelectField_1IST0QT47LS00", "公司", "DDSelectField"),
      expected("DDDateField_B36N2UVUDK80", "日期", "DDDateField"),
      expected("DDSelectField_1K2BNOEQRS800", "申请部门", "DDSelectField"),
      expected("TextareaField_GBCO39RRKFK0", "事由", "TextareaField"),
      expected("TableField_2LQYVLLD4ZC0", "表格", "TableField"),
      expected("MoneyField_1C6K3U65P03K", "费用金额", "MoneyField"),
      expected("DDSelectField_1AH1NRQTNPLS0", "费用项目", "DDSelectField"),
      expected("DDSelectField_6JCCO1D991S0", "费用承担部门", "DDSelectField"),
      expected("TextField_1QEPI0PS61Q80", "备注", "TextField"),
      expected("DDSelectField_84QMA8HYTJC0", "往来单位", "DDSelectField"),
      expected("DDAttachment_1JK87WWW283K0", "发票附件", "DDAttachment"),
      expected("DDAttachment_1W8BOLL7YX5S0", "其他附件", "DDAttachment"),
    ],
    expectedOptions: {
      DDSelectField_1IST0QT47LS00: companyOptions([
        "option_Y4CECUDF00W0",
        "option_0",
        "option_1",
        "option_2",
      ]),
      DDSelectField_1AH1NRQTNPLS0: [
        { value: "AI费用", key: "option_1S2J09XXDCV40" },
        { value: "其它", key: "other" },
      ],
    },
    attachmentComponents: {
      invoice: { id: "DDAttachment_1JK87WWW283K0", label: "发票附件" },
      other: { id: "DDAttachment_1W8BOLL7YX5S0", label: "其他附件" },
    },
  },
  payment_request: {
    processCode: "PROC-5E238117-7121-4CB3-8219-9F11A2E42BE4",
    title: "付款申请",
    expectedComponents: [
      expected("TextField_RI2SYQ7VHQO0", "单据编号", "TextField"),
      expected("DDSelectField_1L4KRXZU5OAO0", "公司", "DDSelectField"),
      expected("TextField_35CD4YZ76JA0", "往来单位", "TextField"),
      expected("TextField_1V3MQHOZF3A80", "收款单位", "TextField"),
      expected("TextField_1MCTJ1KMMFWG0", "币别", "TextField"),
      expected("MoneyField_HLOCQW4U3UO0", "申请付款总金额", "MoneyField"),
      expected("DDDateField_1JQDDBINCMW00", "申请日期", "DDDateField"),
      expected("TableField_GO15CA9H0480", "申请付款金额", "TableField"),
      expected("TextField_A3QJPP1NBZ40", "付款用途", "TextField"),
      expected("TextField_1MPQDLBMHWWW0", "申请付款金额", "TextField"),
      expected("TextField_NRXU1FWNI6O0", "付款原因", "TextField"),
      expected("TextField_K81R7TZF70W0", "费用承担部门", "TextField"),
      expected("TextField_1RUOBECSTA2O0", "对方银行账号", "TextField"),
      expected("TextField_1RZ6OM67ZT5S0", "对方账户名称", "TextField"),
      expected("TextField_IQ99ISRXOUO0", "对方开户行", "TextField"),
      expected("TextField_G6CDQKHU1PC0", "付款方式", "TextField"),
      expected("TextField_9ACNEWARTV00", "我方银行账号", "TextField"),
      expected("TextField_NWCD0HXJ20G0", "我方银行账号名称", "TextField"),
      expected("TextField_1XQSEAMG895S0", "我方开户行", "TextField"),
      expected("DDAttachment_GZOSVB0L8MO0", "附件", "DDAttachment"),
    ],
    expectedOptions: {
      DDSelectField_1L4KRXZU5OAO0: companyOptions([
        "option_1K5YT9ACSXA80",
        "option_0",
        "option_1",
        "option_2",
      ]),
    },
    attachmentComponents: {
      attachment: { id: "DDAttachment_GZOSVB0L8MO0", label: "附件" },
    },
  },
};

export function parseApprovalRequestFields(
  template: ApprovalRequestTemplate,
  fields: unknown,
): ApprovalRequestFields {
  const parsed = template === "expense_reimbursement"
    ? expenseReimbursementFieldsSchema.safeParse(fields)
    : paymentRequestFieldsSchema.safeParse(fields);
  if (!parsed.success) {
    throw new ApprovalMcpError("INVALID_INPUT", `The ${template} fields do not match the approved template contract.`);
  }
  return parsed.data;
}

export function assertApprovalRequestTemplateSchema(template: ApprovalRequestTemplate, payload: unknown): void {
  const contract = APPROVAL_REQUEST_CONTRACTS[template];
  const result = asRecord(unwrapResult(payload));
  const schema = parseSchemaContent(result?.schemaContent);
  if (
    result === undefined ||
    text(result.name) !== contract.title ||
    text(result.procType) !== "inner" ||
    text(schema?.title) !== contract.title
  ) {
    throw templateMismatch(template);
  }
  const components = flattenComponents(schema?.items);
  if (components.some((component) => component.componentName === "DDBizSuite")) {
    throw templateMismatch(template);
  }
  if (components.length !== contract.expectedComponents.length) {
    throw templateMismatch(template);
  }
  const byId = new Map(components.map((component) => [component.id, component]));
  for (const expectedComponent of contract.expectedComponents) {
    const actual = byId.get(expectedComponent.id);
    if (
      actual === undefined ||
      actual.label !== expectedComponent.label ||
      actual.componentName !== expectedComponent.componentName
    ) {
      throw templateMismatch(template);
    }
  }
  for (const [id, expectedOptions] of Object.entries(contract.expectedOptions)) {
    const actual = byId.get(id)?.options;
    if (actual === undefined || JSON.stringify(actual) !== JSON.stringify(expectedOptions)) {
      throw templateMismatch(template);
    }
  }
}

export function assertAttachmentFieldAllowed(
  template: ApprovalRequestTemplate,
  field: ApprovalAttachmentField,
): void {
  if (APPROVAL_REQUEST_CONTRACTS[template].attachmentComponents[field] === undefined) {
    throw new ApprovalMcpError("INVALID_INPUT", `Attachment field ${field} is not allowed for ${template}.`);
  }
}

export function buildApprovalFormComponentValues(
  template: ApprovalRequestTemplate,
  fields: ApprovalRequestFields,
  applicant: ApplicantFormContext,
  attachments: Partial<Record<ApprovalAttachmentField, ApprovalAttachmentFormValue[]>> = {},
): Array<Record<string, unknown>> {
  const values = template === "expense_reimbursement"
    ? buildExpenseValues(fields as ExpenseReimbursementFields, applicant)
    : buildPaymentValues(fields as PaymentRequestFields);
  const contract = APPROVAL_REQUEST_CONTRACTS[template];
  for (const [field, files] of Object.entries(attachments) as Array<[
    ApprovalAttachmentField,
    ApprovalAttachmentFormValue[] | undefined,
  ]>) {
    if (files === undefined || files.length === 0) continue;
    const component = contract.attachmentComponents[field];
    if (component === undefined) throw new ApprovalMcpError("INVALID_INPUT", `Attachment field ${field} is not allowed.`);
    values.push({ id: component.id, name: component.label, value: JSON.stringify(files) });
  }
  return values;
}

function buildExpenseValues(
  fields: ExpenseReimbursementFields,
  applicant: ApplicantFormContext,
): Array<Record<string, unknown>> {
  const values: Array<Record<string, unknown>> = [
    selected("DDSelectField_N9CRRWAYASW0", "申请员工", applicant.applicantName, applicant.applicantName),
    { id: "DDDateField_B36N2UVUDK80", name: "日期", value: fields.date },
    selected("DDSelectField_1K2BNOEQRS800", "申请部门", applicant.departmentName, applicant.departmentName),
    { id: "TextareaField_GBCO39RRKFK0", name: "事由", value: fields.reason },
    {
      id: "TableField_2LQYVLLD4ZC0",
      name: "表格",
      value: JSON.stringify(fields.items.map((item, index) => ({
        rowValue: [
          { label: "费用金额", value: String(item.amount), key: "MoneyField_1C6K3U65P03K" },
          {
            label: "费用项目",
            value: item.category,
            key: "DDSelectField_1AH1NRQTNPLS0",
            extendValue: {
              label: item.category,
              key: selectionOptionKey(
                "expense_reimbursement",
                "DDSelectField_1AH1NRQTNPLS0",
                item.category,
              ),
            },
          },
          {
            label: "费用承担部门",
            value: item.expenseDepartment,
            key: "DDSelectField_6JCCO1D991S0",
            extendValue: { label: item.expenseDepartment, key: item.expenseDepartment },
          },
          { label: "备注", value: item.remark, key: "TextField_1QEPI0PS61Q80" },
        ],
        rowNumber: String(index + 1),
      }))),
    },
    selected("DDSelectField_84QMA8HYTJC0", "往来单位", fields.counterparty, fields.counterparty),
  ];
  if (fields.company !== undefined) {
    values.splice(1, 0, selected(
      "DDSelectField_1IST0QT47LS00",
      "公司",
      fields.company,
      selectionOptionKey("expense_reimbursement", "DDSelectField_1IST0QT47LS00", fields.company),
    ));
  }
  return values;
}

function buildPaymentValues(fields: PaymentRequestFields): Array<Record<string, unknown>> {
  const totalAmount = fields.lines.reduce((sum, line) => sum + line.amount, 0);
  const values: Array<Record<string, unknown>> = [
    { id: "TextField_RI2SYQ7VHQO0", name: "单据编号", value: fields.documentNumber },
    ...(fields.counterparty === undefined
      ? []
      : [{ id: "TextField_35CD4YZ76JA0", name: "往来单位", value: fields.counterparty }]),
    { id: "TextField_1V3MQHOZF3A80", name: "收款单位", value: fields.payee },
    { id: "TextField_1MCTJ1KMMFWG0", name: "币别", value: fields.currency },
    { id: "MoneyField_HLOCQW4U3UO0", name: "申请付款总金额", value: String(totalAmount) },
    { id: "DDDateField_1JQDDBINCMW00", name: "申请日期", value: fields.applicationDate },
    {
      id: "TableField_GO15CA9H0480",
      name: "申请付款金额",
      value: JSON.stringify(fields.lines.map((line, index) => ({
        rowValue: paymentRow(line),
        rowNumber: String(index + 1),
      }))),
    },
  ];
  if (fields.company !== undefined) {
    values.splice(1, 0, selected(
      "DDSelectField_1L4KRXZU5OAO0",
      "公司",
      fields.company,
      selectionOptionKey("payment_request", "DDSelectField_1L4KRXZU5OAO0", fields.company),
    ));
  }
  return values;
}

function paymentRow(line: z.infer<typeof paymentLineSchema>): Array<Record<string, unknown>> {
  return [
    row("付款用途", line.purpose, "TextField_A3QJPP1NBZ40"),
    row("申请付款金额", String(line.amount), "TextField_1MPQDLBMHWWW0"),
    row("付款原因", line.reason, "TextField_NRXU1FWNI6O0"),
    row("费用承担部门", line.expenseDepartment, "TextField_K81R7TZF70W0"),
    row("对方银行账号", line.beneficiaryBankAccount, "TextField_1RUOBECSTA2O0"),
    row("对方账户名称", line.beneficiaryAccountName, "TextField_1RZ6OM67ZT5S0"),
    row("对方开户行", line.beneficiaryBankName, "TextField_IQ99ISRXOUO0"),
    row("付款方式", line.paymentMethod, "TextField_G6CDQKHU1PC0"),
    row("我方银行账号", line.payerBankAccount, "TextField_9ACNEWARTV00"),
    row("我方银行账号名称", line.payerAccountName, "TextField_NWCD0HXJ20G0"),
    row("我方开户行", line.payerBankName, "TextField_1XQSEAMG895S0"),
  ].filter((value): value is Record<string, unknown> => value !== undefined);
}

function row(label: string, value: string | undefined, key: string): Record<string, unknown> | undefined {
  return value === undefined || value === "" ? undefined : { label, value, key };
}

function selected(id: string, name: string, label: string, key: string): Record<string, unknown> {
  return { id, name, value: label, extValue: JSON.stringify({ label, key }) };
}

function selectionOptionKey(template: ApprovalRequestTemplate, componentId: string, value: string): string {
  const key = APPROVAL_REQUEST_CONTRACTS[template].expectedOptions[componentId]
    ?.find((option) => option.value === value)?.key;
  if (key === undefined || key === "") {
    throw new ApprovalMcpError("CONFIGURATION_ERROR", "The allowlisted approval selection option is not configured.");
  }
  return key;
}

function expected(id: string, label: string, componentName: string) {
  return { id, label, componentName } as const;
}

function companyOptions(keys: readonly string[]): ReadonlyArray<{ value: string; key: string }> {
  return MWE_COMPANIES.map((value, index) => ({ value, key: keys[index] ?? "" }));
}

function parseSchemaContent(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

function flattenComponents(
  value: unknown,
): Array<{ id: string; label: string; componentName: string; options: Array<{ value: string; key: string }> }> {
  if (!Array.isArray(value)) return [];
  const result: Array<{
    id: string;
    label: string;
    componentName: string;
    options: Array<{ value: string; key: string }>;
  }> = [];
  for (const item of value) {
    const component = asRecord(item);
    const props = asRecord(component?.props);
    const id = text(props?.id);
    const label = text(props?.label);
    const componentName = text(component?.componentName);
    if (id !== undefined && label !== undefined && componentName !== undefined) {
      result.push({ id, label, componentName, options: parseOptions(props?.options) });
    }
    result.push(...flattenComponents(component?.children));
  }
  return result;
}

function parseOptions(value: unknown): Array<{ value: string; key: string }> {
  if (!Array.isArray(value)) return [];
  const result: Array<{ value: string; key: string }> = [];
  for (const item of value) {
    let option: Record<string, unknown> | undefined;
    if (typeof item === "string") {
      try {
        option = asRecord(JSON.parse(item));
      } catch {
        return [];
      }
    } else {
      option = asRecord(item);
    }
    const optionValue = text(option?.value);
    const optionKey = text(option?.key);
    if (optionValue === undefined || optionKey === undefined) return [];
    result.push({ value: optionValue, key: optionKey });
  }
  return result;
}

function templateMismatch(template: ApprovalRequestTemplate): ApprovalMcpError {
  return new ApprovalMcpError(
    "TEMPLATE_SCHEMA_MISMATCH",
    `The live DingTalk schema for ${template} no longer matches the reviewed allowlisted contract.`,
  );
}
