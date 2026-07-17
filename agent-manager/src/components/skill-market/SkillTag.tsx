/**
 * SkillTag — tag chip component (aligned with ComputeNest SkillTag)
 * Supports checked/hover states with blue accent color (#1890ff)
 */
import React from 'react'

interface SkillTagProps {
  checked?: boolean
  onClick?: () => void
  enableHover?: boolean
  children: React.ReactNode
}

export const SkillTag: React.FC<SkillTagProps> = ({
  checked = false,
  onClick,
  enableHover = true,
  children,
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        inline-flex items-center rounded-full border px-4 py-[5px] text-xs leading-5 transition-all duration-200
        ${checked
          ? 'bg-[#e6f7ff] border-[#91d5ff] text-[#1890ff]'
          : 'bg-white border-[#d9d9d9] text-[rgba(0,0,0,0.85)]'
        }
        ${enableHover && !checked ? 'hover:border-[#1890ff] hover:text-[#1890ff]' : ''}
        ${enableHover && checked ? 'hover:bg-[#bae7ff] hover:border-[#69c0ff]' : ''}
      `}
    >
      {children}
    </button>
  )
}
