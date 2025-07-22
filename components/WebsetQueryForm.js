import { useState } from 'react';
import styles from './WebsetQueryForm.module.css';

export default function WebsetQueryForm({ onSubmit, isLoading }) {
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(10);
  const [enrichments, setEnrichments] = useState([
    { description: 'Extract key contact information', format: 'text' }
  ]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!query.trim()) return;

    onSubmit({
      query: query.trim(),
      count,
      enrichments: enrichments.filter(e => e.description.trim())
    });
  };

  const addEnrichment = () => {
    setEnrichments([...enrichments, { description: '', format: 'text' }]);
  };

  const updateEnrichment = (index, field, value) => {
    const updated = enrichments.map((enrichment, i) => 
      i === index ? { ...enrichment, [field]: value } : enrichment
    );
    setEnrichments(updated);
  };

  const removeEnrichment = (index) => {
    setEnrichments(enrichments.filter((_, i) => i !== index));
  };

  return (
    <div className={styles.formContainer}>
      <form onSubmit={handleSubmit} className={styles.form}>
        <div className={styles.field}>
          <label htmlFor="query">Search Query</label>
          <textarea
            id="query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g., Top AI research labs focusing on large language models"
            rows={3}
            required
            className={styles.textarea}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor="count">Number of Results</label>
          <input
            type="number"
            id="count"
            value={count}
            onChange={(e) => setCount(parseInt(e.target.value) || 1)}
            min="1"
            max="100"
            className={styles.input}
          />
        </div>

        <div className={styles.enrichmentsSection}>
          <h3>Enrichments (Optional)</h3>
          {enrichments.map((enrichment, index) => (
            <div key={index} className={styles.enrichment}>
              <input
                type="text"
                value={enrichment.description}
                onChange={(e) => updateEnrichment(index, 'description', e.target.value)}
                placeholder="e.g., Extract LinkedIn profile information"
                className={styles.input}
              />
              <select
                value={enrichment.format}
                onChange={(e) => updateEnrichment(index, 'format', e.target.value)}
                className={styles.select}
              >
                <option value="text">Text</option>
                <option value="json">JSON</option>
              </select>
              <button
                type="button"
                onClick={() => removeEnrichment(index)}
                className={styles.removeButton}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addEnrichment}
            className={styles.addButton}
          >
            Add Enrichment
          </button>
        </div>

        <button
          type="submit"
          disabled={isLoading || !query.trim()}
          className={styles.submitButton}
        >
          {isLoading ? 'Creating Webset...' : 'Create Webset'}
        </button>
      </form>
    </div>
  );
} 