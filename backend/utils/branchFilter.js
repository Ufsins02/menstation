const ALL_BRANCH_VALUES = new Set(['', 'all', 'null', 'undefined']);

const normalizeBranchId = (value) => {
    if (value === undefined || value === null) return null;

    const raw = String(value).trim();
    if (ALL_BRANCH_VALUES.has(raw.toLowerCase())) return null;
    if (!/^\d+$/.test(raw)) return null;

    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const requestedBranchId = (req) => normalizeBranchId(req.query?.branch_id ?? req.body?.branch_id);

const appendBranchFilter = (sql, params, column, branchId) => {
    if (!branchId) return sql;
    params.push(branchId);
    return `${sql} AND ${column}=?`;
};

module.exports = {
    normalizeBranchId,
    requestedBranchId,
    appendBranchFilter
};
