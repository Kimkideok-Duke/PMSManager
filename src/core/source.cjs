// Public source-search API. File reads and recursive content retrieval are separated.
module.exports = { ...require('./files.cjs'), ...require('./search.cjs') };
