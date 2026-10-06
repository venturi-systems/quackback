import { FormattedMessage } from 'react-intl'

const questions = [
  {
    id: 'suggest',
    question: 'How do I suggest an improvement?',
    answer:
      'Search existing ideas first. If someone has raised the same need, add your vote or a comment. Otherwise, create a request on the relevant board.',
  },
  {
    id: 'include',
    question: 'What makes feedback useful?',
    answer:
      'Describe what you want to achieve, what is getting in the way, and how it affects your work. Include clear steps or an example, without confidential data or credentials.',
  },
  {
    id: 'progress',
    question: 'How do I follow progress?',
    answer:
      'Open a request to see its current status and discussion. The roadmap brings planned and in-progress work together, and the changelog explains what has shipped.',
  },
  {
    id: 'review',
    question: 'What happens after I share an idea?',
    answer:
      'The Venturi team reviews requests, asks follow-up questions, and connects related ideas. Votes help communicate demand; they do not guarantee a delivery date.',
  },
] as const

/** Help for admitted collaborators, rendered only inside the authenticated portal. */
export function PortalFeedbackFaq() {
  return (
    <section className="portal-shell portal-feedback-faq" aria-labelledby="feedback-faq-title">
      <h2 id="feedback-faq-title">
        <FormattedMessage id="portal.feedback.faq.title" defaultMessage="Feedback FAQ" />
      </h2>
      <div className="portal-feedback-faq__questions">
        {questions.map(({ id, question, answer }) => (
          <details key={id}>
            <summary>
              <FormattedMessage
                id={'portal.feedback.faq.' + id + '.question'}
                defaultMessage={question}
              />
            </summary>
            <p>
              <FormattedMessage
                id={'portal.feedback.faq.' + id + '.answer'}
                defaultMessage={answer}
              />
            </p>
          </details>
        ))}
      </div>
    </section>
  )
}
