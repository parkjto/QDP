/**
 * 정보처리기사 합격 확률 추정기
 * - 5과목 점수 기반 휴리스틱 계산
 * - 결과는 0 ~ 100 사이 정수 퍼센트
 */
export const calculatePassProbability = (scores: readonly number[]): number => {
  if (!scores || scores.length !== 5) return 0

  const totalScore = scores.reduce((sum, score) => sum + score, 0)
  const averageScore = totalScore / 5
  const failSubjects = scores.filter((score) => score < 40).length

  const baseProbability =
    averageScore >= 60
      ? 60 + (averageScore - 60) * 1.5
      : 60 - (60 - averageScore) * 2.5

  const finalProbability = Math.round(baseProbability - failSubjects * 25)
  return Math.max(0, Math.min(100, finalProbability))
}

